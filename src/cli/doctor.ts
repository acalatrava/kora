import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { ConfigManager } from '../core/config.js';

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const PASS = chalk.green.bold('PASS');
const FAIL = chalk.red.bold('FAIL');
const WARN = chalk.yellow.bold('WARN');

function printResult(result: CheckResult): void {
  const icon = result.passed ? PASS : FAIL;
  console.log(`  ${icon}  ${result.name}`);
  if (result.detail) {
    console.log(`        ${chalk.gray(result.detail)}`);
  }
}

function checkNodeVersion(): CheckResult {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  return {
    name: 'Node.js version >= 20',
    passed: major >= 20,
    detail: `v${version}`,
  };
}


function checkConfigDir(configPath: string): CheckResult {
  const exists = fs.existsSync(configPath);
  return {
    name: 'Config directory exists',
    passed: exists,
    detail: exists ? configPath : `Not found: ${configPath}`,
  };
}

function checkConfigFile(filePath: string, label: string): CheckResult {
  if (!fs.existsSync(filePath)) {
    return { name: `${label} exists`, passed: false, detail: `Not found: ${filePath}` };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) {
      return { name: `${label} valid`, passed: false, detail: 'File is empty' };
    }
    return { name: `${label} valid`, passed: true, detail: filePath };
  } catch (err) {
    return {
      name: `${label} valid`,
      passed: false,
      detail: `Read error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkSqlite(): Promise<CheckResult> {
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    db.close();
    return { name: 'SQLite works', passed: true, detail: 'better-sqlite3 in-memory test passed' };
  } catch (err) {
    return {
      name: 'SQLite works',
      passed: false,
      detail: `SQLite test failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkProviderKeys(config: ConfigManager): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const providers = config.loadProviders();

  if (providers.length === 0) {
    results.push({ name: 'Provider API keys', passed: false, detail: 'No providers configured' });
    return results;
  }

  for (const provider of providers) {
    if (provider.type === 'openai' && provider.apiKey) {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${provider.apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        results.push({
          name: `Provider "${provider.id}" API key`,
          passed: response.ok,
          detail: response.ok ? 'Key validated' : `HTTP ${response.status}`,
        });
      } catch (err) {
        results.push({
          name: `Provider "${provider.id}" API key`,
          passed: false,
          detail: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else if (provider.type === 'anthropic' && provider.apiKey) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': provider.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: AbortSignal.timeout(10000),
        });
        const passed = response.ok || response.status === 400;
        results.push({
          name: `Provider "${provider.id}" API key`,
          passed,
          detail: passed ? 'Key validated' : `HTTP ${response.status}`,
        });
      } catch (err) {
        results.push({
          name: `Provider "${provider.id}" API key`,
          passed: false,
          detail: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else if (provider.type === 'openai_compat' && provider.baseUrl) {
      try {
        const response = await fetch(`${provider.baseUrl}/models`, {
          headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        results.push({
          name: `Provider "${provider.id}" endpoint`,
          passed: response.ok,
          detail: response.ok ? `Reachable at ${provider.baseUrl}` : `HTTP ${response.status}`,
        });
      } catch (err) {
        results.push({
          name: `Provider "${provider.id}" endpoint`,
          passed: false,
          detail: `Unreachable: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      results.push({
        name: `Provider "${provider.id}"`,
        passed: false,
        detail: 'Missing API key or base URL',
      });
    }
  }

  return results;
}

async function checkTelegramToken(config: ConfigManager): Promise<CheckResult | null> {
  const channels = config.loadChannels();
  const telegram = channels.find(c => c.type === 'telegram' && c.enabled);
  if (!telegram) return null;

  const tgConfig = telegram.config as { token: string };
  if (!tgConfig.token) {
    return { name: 'Telegram bot token', passed: false, detail: 'No token configured' };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${tgConfig.token}/getMe`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json() as { ok: boolean; result?: { username?: string } };
    if (data.ok) {
      return {
        name: 'Telegram bot token',
        passed: true,
        detail: `Bot: @${data.result?.username ?? 'unknown'}`,
      };
    }
    return { name: 'Telegram bot token', passed: false, detail: 'Invalid token' };
  } catch (err) {
    return {
      name: 'Telegram bot token',
      passed: false,
      detail: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkEmailConnection(config: ConfigManager): Promise<CheckResult | null> {
  const channels = config.loadChannels();
  const email = channels.find(c => c.type === 'email' && c.enabled);
  if (!email) return null;

  const emailConfig = email.config as {
    imap: { host: string; port: number; user: string; password: string; tls: boolean };
  };

  try {
    const net = await import('node:net');
    const tls = await import('node:tls');

    return new Promise<CheckResult>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({
          name: 'Email IMAP connection',
          passed: false,
          detail: `Timeout connecting to ${emailConfig.imap.host}:${emailConfig.imap.port}`,
        });
      }, 10000);

      const onConnect = () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({
          name: 'Email IMAP connection',
          passed: true,
          detail: `Connected to ${emailConfig.imap.host}:${emailConfig.imap.port}`,
        });
      };

      const connOpts = { host: emailConfig.imap.host, port: emailConfig.imap.port };
      const socket = emailConfig.imap.tls
        ? tls.connect(connOpts, onConnect)
        : net.connect(connOpts, onConnect);

      socket.on('error', (err: Error) => {
        clearTimeout(timeout);
        resolve({
          name: 'Email IMAP connection',
          passed: false,
          detail: `Failed: ${err.message}`,
        });
      });
    });
  } catch (err) {
    return {
      name: 'Email IMAP connection',
      passed: false,
      detail: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runDoctor(storagePath?: string): Promise<void> {
  const config = new ConfigManager(storagePath);

  console.log(chalk.bold('\n  Kora Doctor\n'));
  console.log(chalk.gray('  Running diagnostic checks...\n'));

  const results: CheckResult[] = [];

  results.push(checkNodeVersion());
  results.push(checkConfigDir(config.configPath));

  results.push(checkConfigFile(path.join(config.configPath, 'settings.yml'), 'settings.yml'));
  results.push(checkConfigFile(path.join(config.configPath, 'providers.yml'), 'providers.yml'));
  results.push(checkConfigFile(path.join(config.configPath, 'channels.yml'), 'channels.yml'));
  results.push(checkConfigFile(path.join(config.configPath, 'AGENT.md'), 'AGENT.md'));
  results.push(checkConfigFile(path.join(config.configPath, 'IDENTITY.md'), 'IDENTITY.md'));

  results.push(await checkSqlite());

  const providerResults = await checkProviderKeys(config);
  results.push(...providerResults);

  const telegramResult = await checkTelegramToken(config);
  if (telegramResult) results.push(telegramResult);

  const emailResult = await checkEmailConnection(config);
  if (emailResult) results.push(emailResult);

  for (const r of results) {
    printResult(r);
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('');
  console.log(`  ${chalk.bold('Results:')} ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)} out of ${results.length} checks`);

  if (failed > 0) {
    console.log(`\n  ${chalk.yellow('Some checks failed. Review the output above and fix any issues.')}`);
  } else {
    console.log(`\n  ${chalk.green('All checks passed. Kora is ready to go.')}`);
  }

  console.log('');
}
