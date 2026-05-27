import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDefinition, SandboxMount } from '../core/types.js';
import type { SandboxProvider } from './sandbox.js';
import { logger } from '../core/logger.js';

const SCOPE = 'shell-tool';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

export interface ManagedExecution {
  promise: Promise<string>;
  getPartialOutput: () => { stdout: string; stderr: string };
  kill: () => void;
}

const SENSITIVE_ENV_KEYS = new Set([
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN', 'GITLAB_TOKEN',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'DATABASE_URL', 'DB_PASSWORD',
  'JWT_SECRET', 'SESSION_SECRET',
  'PRIVATE_KEY', 'SSH_KEY',
]);

export interface ShellToolContext {
  allowedCommands?: string[];
  blockedCommands?: string[];
  workingDirectory?: string;
  timeout?: number;
  allowedPaths?: string[];
  customEnv?: Record<string, string>;
  sandboxProvider?: SandboxProvider;
  sandboxConfig?: {
    mounts: SandboxMount[];
    networkAccess: boolean;
    memoryLimitMb: number;
    image?: string;
    storagePath?: string;
  };
}

export const shellToolDefinitions: ToolDefinition[] = [
  {
    name: 'shell_exec',
    description:
      'Execute a shell command and return its stdout, stderr, and exit code. ' +
      'Use this for system tasks: listing files, checking disk space, running scripts, ' +
      'installing packages, git operations, network diagnostics, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (e.g., "ls -la", "curl https://example.com", "df -h")',
        },
        working_directory: {
          type: 'string',
          description: 'Optional working directory for the command',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds (default 30000)',
        },
      },
      required: ['command'],
    },
  },
];

export async function handleShellTool(
  name: string,
  args: Record<string, unknown>,
  context: ShellToolContext,
): Promise<string> {
  if (name !== 'shell_exec') {
    return JSON.stringify({ ok: false, error: `Unknown shell tool: ${name}` });
  }

  const command = args.command as string;
  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    return JSON.stringify({ ok: false, error: 'Command must be a non-empty string' });
  }

  const rawCwd = (args.working_directory as string | undefined) ?? context.workingDirectory;
  let cwd = rawCwd;
  if (cwd) {
    cwd = resolve(cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return JSON.stringify({ ok: false, error: `Working directory does not exist: ${cwd}` });
    }
  }

  if (context.allowedPaths && context.allowedPaths.length > 0 && cwd) {
    const normalizedCwd = resolve(cwd);
    const isAllowed = context.allowedPaths.some(p => {
      const normalizedAllowed = resolve(p);
      return normalizedCwd === normalizedAllowed || normalizedCwd.startsWith(normalizedAllowed + '/');
    });
    if (!isAllowed) {
      return JSON.stringify({ ok: false, error: `Working directory "${cwd}" is outside allowed paths: ${context.allowedPaths.join(', ')}` });
    }
  }

  const timeout = Math.min(
    (args.timeout_ms as number | undefined) ?? context.timeout ?? DEFAULT_TIMEOUT_MS,
    300_000,
  );

  if (context.allowedCommands && context.allowedCommands.length > 0) {
    const tokens = command.split(/[;&|`$()]\s*|\s+/);
    const cmds = tokens.filter(t => t.length > 0 && !t.startsWith('-'));
    for (const cmd of cmds) {
      const baseName = cmd.split('/').pop() ?? cmd;
      if (!context.allowedCommands.includes(baseName)) {
        return JSON.stringify({
          ok: false,
          error: `Command "${baseName}" is not in the allowed list. Allowed: ${context.allowedCommands.join(', ')}`,
        });
      }
    }
  }

  logger.info(SCOPE, `Executing: ${command}${context.sandboxProvider ? ` [sandbox: ${context.sandboxProvider.name}]` : ''}`);

  // Update customEnv to update HOME to point to the workspace directory
  const customEnv = { ...context.customEnv, HOME: cwd ?? '/tmp' };

  try {
    if (context.sandboxProvider && context.sandboxConfig) {
      const sandboxResult = await context.sandboxProvider.execute(command, {
        cwd,
        timeout,
        mounts: context.sandboxConfig.mounts,
        networkAccess: context.sandboxConfig.networkAccess,
        memoryLimitMb: context.sandboxConfig.memoryLimitMb,
        image: context.sandboxConfig.image,
        storagePath: context.sandboxConfig.storagePath,
        env: customEnv,
      });
      return JSON.stringify({
        ok: sandboxResult.exitCode === 0 && !sandboxResult.timedOut,
        stdout: sandboxResult.stdout,
        stderr: sandboxResult.stderr,
        exitCode: sandboxResult.exitCode,
        sandboxed: true,
        ...(sandboxResult.timedOut ? { timedOut: true } : {}),
      });
    }

    const result = await executeCommand(command, cwd, timeout, customEnv);
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `Command failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}

function buildSanitizedEnv(customEnv?: Record<string, string>): Record<string, string | undefined> {
  const sanitizedEnv: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_KEYS.has(key) && !key.endsWith('_SECRET') && !key.endsWith('_TOKEN') && !key.endsWith('_API_KEY')) {
      sanitizedEnv[key] = val;
    }
  }
  if (customEnv) {
    for (const [key, val] of Object.entries(customEnv)) {
      sanitizedEnv[key] = val;
    }
  }
  return sanitizedEnv;
}

function spawnShellProcess(command: string, cwd?: string, customEnv?: Record<string, string>): {
  child: ChildProcess;
  buffer: { stdout: string; stderr: string };
  onFinish: Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }>;
} {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];
  const sanitizedEnv = buildSanitizedEnv(customEnv);
  // Set HOME to the workspace directory
  sanitizedEnv.HOME = cwd ?? '/tmp';

  const child = spawn(shell, shellArgs, {
    cwd: cwd || process.cwd(),
    env: sanitizedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const buffer = { stdout: '', stderr: '' };

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer.stdout += chunk.toString();
    if (buffer.stdout.length > MAX_OUTPUT_CHARS) {
      buffer.stdout = buffer.stdout.slice(0, MAX_OUTPUT_CHARS) + '\n... [output truncated]';
      child.kill('SIGTERM');
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    buffer.stderr += chunk.toString();
    if (buffer.stderr.length > MAX_OUTPUT_CHARS) {
      buffer.stderr = buffer.stderr.slice(0, MAX_OUTPUT_CHARS) + '\n... [output truncated]';
    }
  });

  const onFinish = new Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }>((resolve) => {
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout: buffer.stdout.trim(),
        stderr: buffer.stderr.trim(),
        exitCode: code ?? 1,
      });
    });
    child.on('error', (err) => {
      resolve({ ok: false, stdout: '', stderr: err.message, exitCode: 1 });
    });
  });

  return { child, buffer, onFinish };
}

function executeCommand(
  command: string,
  cwd?: string,
  timeout: number = DEFAULT_TIMEOUT_MS,
  customEnv?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number; timedOut?: boolean }> {
  return new Promise((resolve) => {
    // Set HOME to the workspace directory
    customEnv = { ...customEnv, HOME: cwd ?? '/tmp' };
    const { child, onFinish } = spawnShellProcess(command, cwd, customEnv);

    let timedOut = false;
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!finished) child.kill('SIGKILL');
        }, 3000);
      }
    }, timeout);

    onFinish.then((result) => {
      finished = true;
      clearTimeout(timer);
      resolve({ ...result, ok: result.ok && !timedOut, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}

/**
 * Creates a managed shell execution that can be observed for partial output
 * and killed externally. Unlike executeCommand, this does NOT apply its own
 * timeout — the caller (dispatcher) manages the detach/wait lifecycle.
 */
export function createManagedShellExecution(
  command: string,
  context: ShellToolContext,
  args: Record<string, unknown>,
): ManagedExecution | { error: string } {
  const rawCwd = (args.working_directory as string | undefined) ?? context.workingDirectory;
  let cwd = rawCwd;
  if (cwd) {
    cwd = resolve(cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return { error: `Working directory does not exist: ${cwd}` };
    }
  }

  if (context.allowedPaths && context.allowedPaths.length > 0 && cwd) {
    const normalizedCwd = resolve(cwd);
    const isAllowed = context.allowedPaths.some(p => {
      const normalizedAllowed = resolve(p);
      return normalizedCwd === normalizedAllowed || normalizedCwd.startsWith(normalizedAllowed + '/');
    });
    if (!isAllowed) {
      return { error: `Working directory "${cwd}" is outside allowed paths: ${context.allowedPaths.join(', ')}` };
    }
  }

  if (context.allowedCommands && context.allowedCommands.length > 0) {
    const tokens = command.split(/[;&|`$()]\s*|\s+/);
    const cmds = tokens.filter(t => t.length > 0 && !t.startsWith('-'));
    for (const cmd of cmds) {
      const baseName = cmd.split('/').pop() ?? cmd;
      if (!context.allowedCommands.includes(baseName)) {
        return { error: `Command "${baseName}" is not in the allowed list. Allowed: ${context.allowedCommands.join(', ')}` };
      }
    }
  }

  if (context.sandboxProvider && context.sandboxConfig) {
    logger.info(SCOPE, `Managed execution (sandboxed via ${context.sandboxProvider.name}): ${command}`);
    const timeout = Math.min(
      (args.timeout_ms as number | undefined) ?? context.timeout ?? DEFAULT_TIMEOUT_MS,
      300_000,
    );
    const sandboxPromise = context.sandboxProvider.execute(command, {
      cwd,
      timeout,
      mounts: context.sandboxConfig.mounts,
      networkAccess: context.sandboxConfig.networkAccess,
      memoryLimitMb: context.sandboxConfig.memoryLimitMb,
      image: context.sandboxConfig.image,
      storagePath: context.sandboxConfig.storagePath,
      env: context.customEnv,
    }).then(sandboxResult => JSON.stringify({
      ok: sandboxResult.exitCode === 0 && !sandboxResult.timedOut,
      stdout: sandboxResult.stdout,
      stderr: sandboxResult.stderr,
      exitCode: sandboxResult.exitCode,
      sandboxed: true,
      ...(sandboxResult.timedOut ? { timedOut: true } : {}),
    }));

    return {
      promise: sandboxPromise,
      getPartialOutput: () => ({ stdout: '', stderr: '' }),
      kill: () => { /* sandbox process lifecycle is managed by the provider */ },
    };
  }

  logger.info(SCOPE, `Managed execution: ${command}`);
  const { child, buffer, onFinish } = spawnShellProcess(command, cwd, context.customEnv);

  const promise = onFinish.then(result => JSON.stringify(result));

  return {
    promise,
    getPartialOutput: () => ({ stdout: buffer.stdout, stderr: buffer.stderr }),
    kill: () => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 3000);
    },
  };
}
