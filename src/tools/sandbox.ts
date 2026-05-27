import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SandboxMount } from '../core/types.js';
import { logger } from '../core/logger.js';

const SCOPE = 'sandbox';
const MAX_OUTPUT_CHARS = 50_000;

let _insideContainer: boolean | null = null;
function isInsideContainer(): boolean {
  if (_insideContainer !== null) return _insideContainer;
  if (existsSync('/.dockerenv')) { _insideContainer = true; return true; }
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
    if (/docker|containerd|kubepods|lxc/i.test(cgroup)) { _insideContainer = true; return true; }
  } catch { /* not linux or unreadable */ }
  _insideContainer = false;
  return false;
}

const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC',
  'TZ', 'TMPDIR', 'PWD', 'SHLVL', 'HOSTNAME', 'COLORTERM',
]);

function buildSafeEnv(opts: SandboxExecOpts): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      env[k] = v;
    }
  }
  return env;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface SandboxExecOpts {
  cwd?: string;
  timeout: number;
  mounts: SandboxMount[];
  networkAccess: boolean;
  memoryLimitMb: number;
  env?: Record<string, string>;
  image?: string;
  storagePath?: string;
}

export interface SandboxProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  execute(command: string, opts: SandboxExecOpts): Promise<SandboxResult>;
  /** Release resources (e.g. pooled containers). Called on app shutdown. */
  destroy?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spawnCollect(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeout: number },
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 3000);
      }
    }, opts.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS) + '\n... [output truncated]';
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT_CHARS) {
        stderr = stderr.slice(0, MAX_OUTPUT_CHARS) + '\n... [output truncated]';
      }
    });

    child.on('close', (code) => {
      finished = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });

    child.on('error', (err) => {
      finished = true;
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: 1 });
    });
  });
}

async function commandExists(cmd: string): Promise<boolean> {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const r = await spawnCollect(which, [cmd], { timeout: 5000 });
  return r.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Docker sandbox
// ---------------------------------------------------------------------------

interface PoolEntry {
  containerId: string;
  lastUsed: number;
  /** Serialised mount+image fingerprint so we reuse only matching containers. */
  fingerprint: string;
}

export class DockerSandbox implements SandboxProvider {
  readonly name = 'docker';

  private volumeName: string | undefined;
  private keepAliveSec: number;
  /** workspaceId → running container */
  private pool = new Map<string, PoolEntry>();
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(keepAliveSec = 0) {
    this.volumeName = process.env.SANDBOX_DOCKER_VOLUME || undefined;
    this.keepAliveSec = keepAliveSec;
    if (this.keepAliveSec > 0) {
      this.reapTimer = setInterval(() => this.reapIdle(), 30_000);
      this.reapTimer.unref();
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await spawnCollect('docker', ['info'], { timeout: 10_000 });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async execute(command: string, opts: SandboxExecOpts): Promise<SandboxResult> {
    if (this.keepAliveSec > 0 && opts.cwd) {
      return this.execInPool(command, opts);
    }
    return this.execOneShot(command, opts);
  }

  /** Gracefully stop all pooled containers (call on app shutdown). */
  async destroy(): Promise<void> { return this.destroyPool(); }

  async destroyPool(): Promise<void> {
    if (this.reapTimer) { clearInterval(this.reapTimer); this.reapTimer = null; }
    const ids = [...this.pool.values()].map(e => e.containerId);
    this.pool.clear();
    await Promise.allSettled(ids.map(id =>
      spawnCollect('docker', ['rm', '-f', id], { timeout: 10_000 }),
    ));
    logger.info(SCOPE, `Docker pool: destroyed ${ids.length} container(s)`);
  }

  // -----------------------------------------------------------------------
  // One-shot execution (no pool)
  // -----------------------------------------------------------------------

  private async execOneShot(command: string, opts: SandboxExecOpts): Promise<SandboxResult> {
    const args: string[] = ['run', '--rm'];
    this.appendSecurityFlags(args, opts);
    this.appendMounts(args, opts);

    const mappedCwd = opts.cwd ? this.mapCwd(opts.cwd, opts.mounts) : '/workspace';
    args.push('-w', mappedCwd);
    this.appendEnv(args, opts, mappedCwd);

    args.push(opts.image || 'node:22-bookworm-slim');
    args.push('/bin/sh', '-c', command);

    logger.debug(SCOPE, `Docker run: docker ${args.slice(0, 8).join(' ')} ... "${command.slice(0, 80)}..."`);
    return spawnCollect('docker', args, { timeout: opts.timeout + 10_000 });
  }

  // -----------------------------------------------------------------------
  // Pooled execution (keep-alive)
  // -----------------------------------------------------------------------

  private poolKey(opts: SandboxExecOpts): string {
    return opts.cwd || '__global__';
  }

  private fingerprint(opts: SandboxExecOpts): string {
    const parts = opts.mounts.map(m => `${m.hostPath}:${m.containerPath}:${m.mode}`).sort();
    parts.push(opts.image || 'node:22-bookworm-slim');
    parts.push(String(opts.networkAccess));
    return parts.join('|');
  }

  private async ensureContainer(opts: SandboxExecOpts): Promise<{ containerId: string; mappedCwd: string }> {
    const key = this.poolKey(opts);
    const fp = this.fingerprint(opts);
    const existing = this.pool.get(key);

    if (existing && existing.fingerprint === fp) {
      const check = await spawnCollect('docker', ['inspect', '-f', '{{.State.Running}}', existing.containerId], { timeout: 5_000 });
      if (check.exitCode === 0 && check.stdout.trim() === 'true') {
        existing.lastUsed = Date.now();
        const mappedCwd = opts.cwd ? this.mapCwd(opts.cwd, opts.mounts) : '/workspace';
        return { containerId: existing.containerId, mappedCwd };
      }
      this.pool.delete(key);
      spawnCollect('docker', ['rm', '-f', existing.containerId], { timeout: 5_000 }).catch(() => { });
    }

    const containerName = `kora-sandbox-${randomUUID().slice(0, 12)}`;
    const args: string[] = ['run', '-d', '--name', containerName];
    this.appendSecurityFlags(args, opts);
    this.appendMounts(args, opts);

    const mappedCwd = opts.cwd ? this.mapCwd(opts.cwd, opts.mounts) : '/workspace';
    args.push('-w', mappedCwd);
    this.appendEnv(args, opts, mappedCwd);

    args.push(opts.image || 'node:22-bookworm-slim');
    args.push('sleep', String(this.keepAliveSec + 60));

    logger.info(SCOPE, `Docker pool: creating container ${containerName} (keep-alive ${this.keepAliveSec}s)`);
    const result = await spawnCollect('docker', args, { timeout: 30_000 });
    if (result.exitCode !== 0) {
      logger.error(SCOPE, `Docker pool: failed to create container: ${result.stderr}`);
      throw new Error(`Failed to create sandbox container: ${result.stderr}`);
    }

    const containerId = result.stdout.trim().slice(0, 12);
    this.pool.set(key, { containerId, lastUsed: Date.now(), fingerprint: fp });
    return { containerId, mappedCwd };
  }

  private async execInPool(command: string, opts: SandboxExecOpts): Promise<SandboxResult> {
    const { containerId, mappedCwd } = await this.ensureContainer(opts);

    const args = ['exec'];
    args.push('-w', mappedCwd);
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push('-e', k === 'HOME' ? `HOME=${mappedCwd}` : `${k}=${v}`);
      }
    }
    if (!opts.env?.['HOME']) {
      args.push('-e', `HOME=${mappedCwd}`);
    }
    args.push(containerId, '/bin/sh', '-c', command);

    logger.debug(SCOPE, `Docker exec [${containerId}]: "${command.slice(0, 80)}..."`);
    return spawnCollect('docker', args, { timeout: opts.timeout + 5_000 });
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const ttl = this.keepAliveSec * 1000;
    for (const [key, entry] of this.pool) {
      if (now - entry.lastUsed > ttl) {
        this.pool.delete(key);
        logger.info(SCOPE, `Docker pool: reaping idle container ${entry.containerId}`);
        spawnCollect('docker', ['rm', '-f', entry.containerId], { timeout: 10_000 }).catch(() => { });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------

  private appendSecurityFlags(args: string[], opts: SandboxExecOpts): void {
    if (!opts.networkAccess) args.push('--network', 'none');
    if (opts.memoryLimitMb > 0) args.push('--memory', `${opts.memoryLimitMb}m`);
    args.push('--cpus', '1');
    args.push('--pids-limit', '100');
    args.push('--security-opt', 'no-new-privileges');
    //args.push('--read-only');
    //args.push('--tmpfs', '/tmp:rw,noexec,size=64m');
  }

  private appendMounts(args: string[], opts: SandboxExecOpts): void {
    if (this.volumeName && opts.storagePath) {
      this.mountViaNamedVolume(args, opts);
    } else {
      for (const m of opts.mounts) {
        args.push('-v', `${m.hostPath}:${m.containerPath}:${m.mode}`);
      }
    }
  }

  private appendEnv(args: string[], opts: SandboxExecOpts, mappedCwd: string): void {
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push('-e', k === 'HOME' ? `HOME=${mappedCwd}` : `${k}=${v}`);
      }
    }
    if (!opts.env?.['HOME']) {
      args.push('-e', `HOME=${mappedCwd}`);
    }
  }

  private mountViaNamedVolume(args: string[], opts: SandboxExecOpts): void {
    const storage = resolve(opts.storagePath!);
    for (const m of opts.mounts) {
      const abs = resolve(m.hostPath);
      if (abs.startsWith(storage + '/') || abs === storage) {
        const subpath = abs === storage ? '' : relative(storage, abs);
        if (subpath) {
          args.push(
            '--mount',
            `type=volume,source=${this.volumeName},target=${m.containerPath},volume-subpath=${subpath}${m.mode === 'ro' ? ',readonly' : ''}`,
          );
        } else {
          args.push(
            '--mount',
            `type=volume,source=${this.volumeName},target=${m.containerPath}${m.mode === 'ro' ? ',readonly' : ''}`,
          );
        }
      } else {
        args.push('-v', `${m.hostPath}:${m.containerPath}:${m.mode}`);
      }
    }
  }

  private mapCwd(hostCwd: string, mounts: SandboxMount[]): string {
    for (const m of mounts) {
      if (hostCwd === m.hostPath || hostCwd.startsWith(m.hostPath + '/')) {
        const rel = hostCwd.slice(m.hostPath.length);
        return m.containerPath + rel;
      }
    }
    return '/workspace';
  }
}

// ---------------------------------------------------------------------------
// Firejail sandbox (Linux)
// ---------------------------------------------------------------------------

export class FirejailSandbox implements SandboxProvider {
  readonly name = 'firejail';

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    if (isInsideContainer()) {
      logger.debug(SCOPE, 'Firejail unavailable: running inside a container (use Docker sandbox instead)');
      return false;
    }
    return commandExists('firejail');
  }

  async execute(command: string, opts: SandboxExecOpts): Promise<SandboxResult> {
    const profile = this.buildProfile(opts);

    const profileDir = join(tmpdir(), 'korabot-sandbox');
    mkdirSync(profileDir, { recursive: true });
    const profilePath = join(profileDir, `fj-${randomUUID()}.profile`);
    writeFileSync(profilePath, profile, 'utf-8');

    try {
      const env = buildSafeEnv(opts);
      env['HOME'] = opts.cwd || '/tmp';

      const args = [
        `--profile=${profilePath}`,
        '--', '/bin/sh', '-c', command,
      ];

      logger.debug(SCOPE, `Firejail exec: firejail --profile=... /bin/sh -c "${command.slice(0, 100)}..."`);

      return spawnCollect('firejail', args, { cwd: opts.cwd, env, timeout: opts.timeout });
    } finally {
      try { unlinkSync(profilePath); } catch { /* best effort */ }
    }
  }

  private buildProfile(opts: SandboxExecOpts): string {
    const lines: string[] = [
      'quiet',
      'seccomp',
      'noroot',
      'caps.drop all',
      'nonewprivs',
      'shell none',
      '',
      'private',
      'private-tmp',
      'private-dev',
      '',
      'rlimit-nproc 50',
      'rlimit-nofile 256',
      'rlimit-fsize 52428800',
    ];

    if (!opts.networkAccess) lines.push('net none');
    if (opts.memoryLimitMb > 0) lines.push(`rlimit-as ${opts.memoryLimitMb * 1024 * 1024}`);
    lines.push('');

    const blacklists = this.computeBlacklists(opts);
    for (const b of blacklists) {
      lines.push(`blacklist ${b}`);
    }
    lines.push('');

    for (const m of opts.mounts) {
      if (m.mode === 'ro') {
        lines.push(`read-only ${m.hostPath}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Computes granular blacklist entries so that only the mount paths
   * remain accessible under the storage root. Firejail's --whitelist
   * only covers $HOME, /tmp, /dev, etc., so for arbitrary roots like
   * /data we blacklist sibling entries at each level instead.
   */
  private computeBlacklists(opts: SandboxExecOpts): string[] {
    const allowed = new Set<string>();
    for (const m of opts.mounts) allowed.add(resolve(m.hostPath));
    if (opts.cwd) allowed.add(resolve(opts.cwd));

    const blacklists: string[] = [
      '/root', '/home',
      '/etc/shadow', '/etc/gshadow',
    ];

    if (!opts.storagePath) return blacklists;

    const storage = resolve(opts.storagePath);
    this.blacklistExcept(storage, allowed, blacklists, 0);

    return blacklists;
  }

  private blacklistExcept(
    dir: string,
    allowed: Set<string>,
    out: string[],
    depth: number,
  ): void {
    if (depth > 3) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch { return; }

    for (const name of entries) {
      const full = join(dir, name);

      const isAllowed = allowed.has(full);
      const hasAllowedChild = [...allowed].some(a => a.startsWith(full + '/'));

      if (isAllowed) {
        continue;
      } else if (hasAllowedChild) {
        try {
          if (statSync(full).isDirectory()) {
            this.blacklistExcept(full, allowed, out, depth + 1);
          }
        } catch { /* skip unreadable entries */ }
      } else {
        out.push(full);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// macOS Seatbelt sandbox (sandbox-exec)
// ---------------------------------------------------------------------------

export class MacOSSeatbeltSandbox implements SandboxProvider {
  readonly name = 'macos_seatbelt';

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    return commandExists('sandbox-exec');
  }

  async execute(command: string, opts: SandboxExecOpts): Promise<SandboxResult> {
    const profile = this.buildProfile(opts);

    const profileDir = join(tmpdir(), 'korabot-sandbox');
    mkdirSync(profileDir, { recursive: true });
    const profilePath = join(profileDir, `profile-${randomUUID()}.sb`);
    writeFileSync(profilePath, profile, 'utf-8');

    try {
      logger.debug(SCOPE, `Seatbelt exec: sandbox-exec -f ${profilePath} /bin/sh -c "${command.slice(0, 100)}..."`);

      const env = buildSafeEnv(opts);
      env['HOME'] = opts.cwd || '/tmp';

      const wrappedCommand = `${command} 2>&1 || { echo "[sandbox-debug] exit=$?" >&2; }`;

      const result = await spawnCollect(
        'sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', wrappedCommand],
        { cwd: opts.cwd, env, timeout: opts.timeout },
      );

      if (result.exitCode !== 0 && !result.stderr && !result.stdout) {
        logger.warn(SCOPE, `Seatbelt command failed silently (exit ${result.exitCode}). This usually means the sandbox denied a file/process operation. Check macOS Console.app for sandbox violation logs.`);
      }

      // Get exitCode from stderr
      const exitCodeMatch = result.stderr.match(/exit=([0-9]+)/);
      if (exitCodeMatch) {
        result.exitCode = parseInt(exitCodeMatch[1]);
      }

      return result;
    } finally {
      try { unlinkSync(profilePath); } catch { /* best effort */ }
    }
  }

  private buildProfile(opts: SandboxExecOpts): string {
    const userTmpDir = tmpdir();
    const userHome = homedir();

    // macOS APFS uses firmlinks, cryptexes, and synthetic mounts that resolve
    // to paths at the kernel level. Restricting file-read* to explicit subtrees
    // breaks binary execution entirely. The proven approach: allow reads globally
    // then deny sensitive user directories to protect credentials and secrets.
    const lines: string[] = [
      '(version 1)',
      '(deny default)',
      '',
      '; Process operations',
      '(allow process*)',
      '(allow signal)',
      '',
      '; Read access — global (required for macOS APFS firmlinks and dyld)',
      '(allow file-read*)',
      '',
      '; DENY reads on sensitive user directories (credentials, keys, secrets)',
      `(deny file-read* (subpath "${userHome}"))`,
      `(allow file-read* (subpath "/Users/Shared"))`,
    ];

    // Deny the storage root so other workspaces, config, and DB are hidden.
    // Mount paths are re-allowed below (allow rules after deny take precedence
    // in seatbelt when they appear later in the profile).
    if (opts.storagePath) {
      const sp = resolve(opts.storagePath);
      if (sp !== userHome && !sp.startsWith(userHome + '/')) {
        lines.push(`(deny file-read* (subpath "${sp}"))`);
        lines.push(`(deny file-write* (subpath "${sp}"))`);
      }
    }

    lines.push(
      '',
      '; Device nodes — write access for shell I/O, redirects, pty',
      '(allow file-write*',
      '  (literal "/dev/null")',
      '  (literal "/dev/zero")',
      '  (literal "/dev/stdin")',
      '  (literal "/dev/stdout")',
      '  (literal "/dev/stderr")',
      '  (literal "/dev/dtracehelper")',
      '  (regex #"^/dev/fd/")',
      '  (regex #"^/dev/tty")',
      '  (regex #"^/dev/pty")',
      ')',
      '(allow file-ioctl)',
      '',
      '; Temp directories (write)',
      '(allow file-write* (subpath "/tmp"))',
      '(allow file-write* (subpath "/private/tmp"))',
      `(allow file-write* (subpath "${userTmpDir}"))`,
      '',
      '; System calls and IPC',
      '(allow sysctl*)',
      '(allow mach*)',
      '(allow ipc-posix*)',
      '(allow iokit-open)',
    );

    for (const m of opts.mounts) {
      lines.push('');
      lines.push(`; Mount ${m.mode}: ${m.hostPath}`);
      lines.push(`(allow file-read* (subpath "${m.hostPath}"))`);
      if (m.mode === 'rw') {
        lines.push(`(allow file-write* (subpath "${m.hostPath}"))`);
      }
    }

    if (opts.cwd) {
      lines.push('');
      lines.push('; Working directory');
      lines.push(`(allow file-read* (subpath "${opts.cwd}"))`);
      lines.push(`(allow file-write* (subpath "${opts.cwd}"))`);
    }

    if (opts.networkAccess) {
      lines.push('');
      lines.push('; Network access');
      lines.push('(allow network*)');
    }

    lines.push('');
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface SandboxStatus {
  available: boolean;
  activeBackend: string | null;
  firejailAvailable: boolean;
  dockerAvailable: boolean;
  seatbeltAvailable: boolean;
}

export async function probeSandboxAvailability(): Promise<SandboxStatus> {
  const firejail = new FirejailSandbox();
  const docker = new DockerSandbox();
  const seatbelt = new MacOSSeatbeltSandbox();

  const [firejailOk, dockerOk, seatbeltOk] = await Promise.all([
    firejail.isAvailable(),
    docker.isAvailable(),
    seatbelt.isAvailable(),
  ]);

  let activeBackend: string | null = null;
  if (isInsideContainer()) {
    if (dockerOk) activeBackend = 'docker';
    else if (firejailOk) activeBackend = 'firejail';
  } else {
    if (firejailOk) activeBackend = 'firejail';
    else if (seatbeltOk) activeBackend = 'macos_seatbelt';
    else if (dockerOk) activeBackend = 'docker';
  }

  return {
    available: firejailOk || dockerOk || seatbeltOk,
    activeBackend,
    firejailAvailable: firejailOk,
    dockerAvailable: dockerOk,
    seatbeltAvailable: seatbeltOk,
  };
}

export interface DetectSandboxOpts {
  backend?: 'auto' | 'docker' | 'macos_seatbelt' | 'firejail';
  dockerKeepAliveSec?: number;
}

export async function detectSandboxProvider(
  optsOrBackend: DetectSandboxOpts | 'auto' | 'docker' | 'macos_seatbelt' | 'firejail' = 'auto',
): Promise<SandboxProvider | null> {
  const opts: DetectSandboxOpts = typeof optsOrBackend === 'string'
    ? { backend: optsOrBackend }
    : optsOrBackend;
  const backend = opts.backend ?? 'auto';
  const keepAlive = opts.dockerKeepAliveSec ?? 0;

  if (backend === 'firejail') {
    const p = new FirejailSandbox();
    if (await p.isAvailable()) return p;
    logger.warn(SCOPE, 'Firejail backend requested but not available (inside container or not installed)');
    return null;
  }

  if (backend === 'docker') {
    const p = new DockerSandbox(keepAlive);
    if (await p.isAvailable()) return p;
    logger.warn(SCOPE, 'Docker backend requested but Docker is not available');
    return null;
  }

  if (backend === 'macos_seatbelt') {
    const p = new MacOSSeatbeltSandbox();
    if (await p.isAvailable()) return p;
    logger.warn(SCOPE, 'macOS Seatbelt backend requested but not available (not macOS or sandbox-exec missing)');
    return null;
  }

  if (isInsideContainer()) {
    const docker = new DockerSandbox(keepAlive);
    if (await docker.isAvailable()) {
      logger.info(SCOPE, `Auto-detected sandbox backend: Docker (running inside container, keep-alive=${keepAlive}s)`);
      return docker;
    }
  }

  const firejail = new FirejailSandbox();
  if (await firejail.isAvailable()) {
    logger.info(SCOPE, 'Auto-detected sandbox backend: Firejail');
    return firejail;
  }

  const seatbelt = new MacOSSeatbeltSandbox();
  if (await seatbelt.isAvailable()) {
    logger.info(SCOPE, 'Auto-detected sandbox backend: macOS Seatbelt (sandbox-exec)');
    return seatbelt;
  }

  const docker = new DockerSandbox(keepAlive);
  if (await docker.isAvailable()) {
    logger.info(SCOPE, `Auto-detected sandbox backend: Docker (keep-alive=${keepAlive}s)`);
    return docker;
  }

  logger.warn(SCOPE, 'No sandbox backend available. Install firejail (Linux), Docker, or run on macOS for sandbox support.');
  return null;
}
