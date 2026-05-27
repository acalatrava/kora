import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';

const SERVICE_NAME = 'korabot';
const LAUNCHD_LABEL = 'com.korabot.agent';

function getKoraPath(): string {
  try {
    return execSync('which kora', { encoding: 'utf-8' }).trim();
  } catch {
    const npmGlobal = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const candidate = path.join(npmGlobal, '..', '.bin', 'kora');
    if (fs.existsSync(candidate)) return candidate;
    return path.resolve('dist/cli/index.js');
  }
}

function getNodePath(): string {
  try {
    return execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    return 'node';
  }
}

// ---------- macOS (launchd) ----------

function launchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function generatePlist(): string {
  const koraPath = getKoraPath();
  const nodePath = getNodePath();
  const logDir = path.join(os.homedir(), '.kora', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const isJs = koraPath.endsWith('.js');
  const programArgs = isJs
    ? `    <string>${nodePath}</string>\n    <string>${koraPath}</string>\n    <string>start</string>`
    : `    <string>${koraPath}</string>\n    <string>start</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, 'stderr.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>${process.env.KORA_STORAGE_PATH ? `
    <key>KORA_STORAGE_PATH</key>
    <string>${process.env.KORA_STORAGE_PATH}</string>` : ''}
  </dict>
  <key>WorkingDirectory</key>
  <string>${os.homedir()}</string>
</dict>
</plist>`;
}

function installLaunchd(): void {
  const plistPath = launchdPlistPath();
  const dir = path.dirname(plistPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(plistPath, generatePlist());
  console.log(chalk.green(`  Plist written to ${plistPath}`));
  try {
    execSync(`launchctl load ${plistPath}`, { stdio: 'pipe' });
    console.log(chalk.green('  Service loaded and will start on login'));
  } catch (err) {
    console.log(chalk.yellow('  Service file installed. Load manually if needed:'));
    console.log(chalk.gray(`    launchctl load ${plistPath}`));
  }
}

function uninstallLaunchd(): void {
  const plistPath = launchdPlistPath();
  try {
    execSync(`launchctl unload ${plistPath}`, { stdio: 'pipe' });
  } catch { /* not loaded */ }
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    console.log(chalk.green('  Service uninstalled'));
  } else {
    console.log(chalk.yellow('  Service was not installed'));
  }
}

function startLaunchd(): void {
  const plistPath = launchdPlistPath();
  if (!fs.existsSync(plistPath)) {
    console.log(chalk.yellow('  Service not installed. Run `kora service install` first.'));
    return;
  }
  try {
    execSync(`launchctl load ${plistPath}`, { stdio: 'pipe' });
    console.log(chalk.green('  Service started (loaded into launchd)'));
  } catch {
    try {
      execSync(`launchctl start ${LAUNCHD_LABEL}`, { stdio: 'pipe' });
      console.log(chalk.green('  Service started'));
    } catch (err) {
      console.log(chalk.red(`  Failed to start: ${(err as Error).message}`));
    }
  }
}

function stopLaunchd(): void {
  const plistPath = launchdPlistPath();
  try {
    execSync(`launchctl unload ${plistPath}`, { stdio: 'pipe' });
    console.log(chalk.green('  Service stopped (unloaded from launchd)'));
  } catch {
    try {
      execSync(`launchctl stop ${LAUNCHD_LABEL}`, { stdio: 'pipe' });
      console.log(chalk.green('  Service stopped'));
    } catch (err) {
      console.log(chalk.red(`  Failed to stop: ${(err as Error).message}`));
    }
  }
}

function statusLaunchd(): void {
  try {
    const output = execSync(`launchctl list | grep ${LAUNCHD_LABEL}`, { encoding: 'utf-8' });
    const parts = output.trim().split(/\s+/);
    const pid = parts[0];
    const exitCode = parts[1];
    const running = pid && pid !== '-';
    console.log(chalk.bold('\n  Kora Service Status\n'));
    console.log(`  ${chalk.gray('Status:')}    ${running ? chalk.green('Running') : chalk.yellow('Stopped')}`);
    if (running) console.log(`  ${chalk.gray('PID:')}       ${chalk.cyan(pid)}`);
    if (exitCode && exitCode !== '0') console.log(`  ${chalk.gray('Exit code:')} ${chalk.red(exitCode)}`);
    console.log(`  ${chalk.gray('Plist:')}     ${launchdPlistPath()}`);
    const logDir = path.join(os.homedir(), '.kora', 'logs');
    console.log(`  ${chalk.gray('Logs:')}      ${logDir}`);
    console.log('');
  } catch {
    console.log(chalk.yellow('  Service is not installed or not running'));
  }
}

// ---------- Linux (systemd) ----------

function systemdServicePath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function generateSystemdUnit(): string {
  const koraPath = getKoraPath();
  const nodePath = getNodePath();
  const isJs = koraPath.endsWith('.js');
  const execStart = isJs ? `${nodePath} ${koraPath} start` : `${koraPath} start`;

  return `[Unit]
Description=Kora AI Agent
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
WorkingDirectory=${os.homedir()}
Environment=PATH=${process.env.PATH}
Environment=HOME=${os.homedir()}${process.env.KORA_STORAGE_PATH ? `\nEnvironment=KORA_STORAGE_PATH=${process.env.KORA_STORAGE_PATH}` : ''}

[Install]
WantedBy=default.target
`;
}

function installSystemd(): void {
  const svcPath = systemdServicePath();
  fs.mkdirSync(path.dirname(svcPath), { recursive: true });
  fs.writeFileSync(svcPath, generateSystemdUnit());
  console.log(chalk.green(`  Unit file written to ${svcPath}`));
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'pipe' });
    console.log(chalk.green('  Service enabled (will start on login)'));
  } catch (err) {
    console.log(chalk.yellow('  Enable manually:'));
    console.log(chalk.gray(`    systemctl --user enable ${SERVICE_NAME}`));
  }
}

function uninstallSystemd(): void {
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' });
    execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'pipe' });
  } catch { /* not running */ }
  const svcPath = systemdServicePath();
  if (fs.existsSync(svcPath)) {
    fs.unlinkSync(svcPath);
    try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch { /* ok */ }
    console.log(chalk.green('  Service uninstalled'));
  } else {
    console.log(chalk.yellow('  Service was not installed'));
  }
}

function startSystemd(): void {
  try {
    execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'pipe' });
    console.log(chalk.green('  Service started'));
  } catch (err) {
    console.log(chalk.red(`  Failed to start: ${(err as Error).message}`));
  }
}

function stopSystemd(): void {
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' });
    console.log(chalk.green('  Service stopped'));
  } catch (err) {
    console.log(chalk.red(`  Failed to stop: ${(err as Error).message}`));
  }
}

function statusSystemd(): void {
  try {
    const output = execSync(`systemctl --user status ${SERVICE_NAME} --no-pager`, { encoding: 'utf-8' });
    console.log(chalk.bold('\n  Kora Service Status\n'));
    console.log(output);
  } catch (err) {
    const output = (err as { stdout?: string }).stdout;
    if (output) {
      console.log(chalk.bold('\n  Kora Service Status\n'));
      console.log(output);
    } else {
      console.log(chalk.yellow('  Service is not installed'));
    }
  }
}

// ---------- Public API ----------

const isMac = os.platform() === 'darwin';

export function serviceInstall(): void {
  console.log(chalk.cyan.bold(`\n  Installing Kora as ${isMac ? 'launchd' : 'systemd'} service...\n`));
  if (isMac) installLaunchd(); else installSystemd();
  console.log('');
}

export function serviceUninstall(): void {
  console.log(chalk.cyan.bold(`\n  Uninstalling Kora service...\n`));
  if (isMac) uninstallLaunchd(); else uninstallSystemd();
  console.log('');
}

export function serviceRestart(): void {
  console.log(chalk.cyan.bold(`\n  Restarting Kora service...\n`));
  if (isMac) restartLaunchd(); else restartSystemd();
  console.log('');
}

export function restartLaunchd(): void {
  stopLaunchd();
  startLaunchd();
}

export function restartSystemd(): void {
  stopSystemd();
  startSystemd();
}

export function serviceStart(): void {
  if (isMac) startLaunchd(); else startSystemd();
}

export function serviceStop(): void {
  if (isMac) stopLaunchd(); else stopSystemd();
}

export function serviceStatus(): void {
  if (isMac) statusLaunchd(); else statusSystemd();
}
