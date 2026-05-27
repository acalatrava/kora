import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { getConfig } from '../core/config.js';
import { DatabaseManager } from '../core/database.js';
import { AdminAuth } from '../core/admin-auth.js';

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? chalk.gray(` (${defaultValue})`) : '';
  return new Promise((resolve) => {
    rl.question(`  ${chalk.green('?')} ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function askPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdout = process.stdout;
    stdout.write(`  ${chalk.green('?')} ${question}: `);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let password = '';
    const onData = (ch: Buffer) => {
      const c = ch.toString('utf8');
      if (c === '\n' || c === '\r' || c === '\u0004') {
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(password);
      } else if (c === '\u0003') {
        process.exit(1);
      } else if (c === '\u007F' || c === '\b') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          stdout.write('\b \b');
        }
      } else {
        password += c;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

export async function runResetAdmin(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const config = getConfig();
    if (!config.isConfigured()) {
      console.log(chalk.yellow('\n  Kora is not configured. Run `kora setup` first.\n'));
      process.exit(1);
    }

    const settings = config.loadSettings();
    const dataDir = path.join(settings.storagePath, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'korabot.db');
    const db = new DatabaseManager(dbPath);
    db.initialize();
    const adminAuth = new AdminAuth(db);

    console.log(chalk.bold('\n  Reset Admin Credentials\n'));

    const currentUser = adminAuth.getUsername();
    if (currentUser) {
      console.log(chalk.gray(`  Current admin username: ${currentUser}\n`));
    }

    const username = await ask(rl, 'New admin username', currentUser || 'admin');

    rl.close();

    let password = '';
    while (true) {
      const p1 = await askPassword('New admin password');
      if (!p1 || p1.length < 6) {
        console.log(chalk.yellow('  ⚠ Password must be at least 6 characters.'));
        continue;
      }
      const p2 = await askPassword('Confirm password');
      if (p1 !== p2) {
        console.log(chalk.yellow('  ⚠ Passwords do not match. Try again.'));
        continue;
      }
      password = p1;
      break;
    }

    await adminAuth.setCredentials(username, password);
    adminAuth.clear2FA();
    db.close();

    console.log(chalk.green(`\n  ✓ Admin credentials updated for "${username}"\n`));
    console.log(chalk.gray('  2FA has been reset. You will need to set it up again on next login.\n'));
    console.log(chalk.gray('  Changes take effect immediately (no restart needed).\n'));
  } catch (err) {
    console.error(chalk.red(`\n  Failed: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }
  process.exit(0);
}
