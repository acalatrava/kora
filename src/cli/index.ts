#!/usr/bin/env node

import { Command } from 'commander';
import { runSetup } from './setup.js';
import { runStart } from './start.js';
import { runDoctor } from './doctor.js';
import { serviceInstall, serviceUninstall, serviceStart, serviceStop, serviceStatus, serviceRestart } from './service.js';

const program = new Command();

program
  .name('kora')
  .description('Kora — Local-first multi-channel AI Agent runtime')
  .version('0.1.0');

program
  .command('setup')
  .description('Run the interactive setup wizard')
  .action(async () => {
    await runSetup();
    process.exit(0);
  });

program
  .command('start')
  .description('Start the agent runtime')
  .action(async () => {
    await runStart();
  });

program
  .command('status')
  .description('Show current runtime status')
  .action(async () => {
    const chalk = (await import('chalk')).default;
    const { getConfig } = await import('../core/config.js');
    const config = getConfig();

    if (!config.isConfigured()) {
      console.log(chalk.yellow('Kora is not configured. Run `kora setup` first.'));
      process.exit(1);
    }

    const settings = config.loadSettings();
    const providers = config.loadProviders();
    const channels = config.loadChannels();

    console.log(chalk.bold('\n  Kora Status\n'));
    console.log(`  Storage path:      ${chalk.cyan(settings.storagePath)}`);
    console.log(`  Mode:              ${chalk.cyan(settings.multiUser ? 'multi-user' : 'single-user')}`);
    console.log(`  Default provider:  ${chalk.cyan(settings.defaultProvider)}`);
    console.log(`  Default model:     ${chalk.cyan(settings.defaultModel)}`);
    console.log(`  Providers:         ${chalk.cyan(String(providers.length))}`);
    console.log(`  Channels:          ${chalk.cyan(String(channels.filter(c => c.enabled).length))} enabled`);
    console.log(`  Log level:         ${chalk.cyan(settings.logLevel)}`);
    console.log('');
    process.exit(0);
  });

program
  .command('doctor')
  .description('Run diagnostic checks')
  .action(async () => {
    await runDoctor();
    process.exit(0);
  });

program
  .command('reset-admin')
  .description('Reset web admin username and password')
  .action(async () => {
    const { runResetAdmin } = await import('./reset-admin.js');
    await runResetAdmin();
    process.exit(0);
  });

const svc = program
  .command('service')
  .description('Manage Kora as a system service (systemd/launchd)');

svc.command('install')
  .description('Install Kora as a system service that starts on login')
  .action(() => { serviceInstall(); process.exit(0); });

svc.command('uninstall')
  .description('Remove the Kora system service')
  .action(() => { serviceUninstall(); process.exit(0); });

svc.command('start')
  .description('Start the Kora service')
  .action(() => { serviceStart(); process.exit(0); });

svc.command('restart')
  .description('Restart the Kora service')
  .action(() => { serviceRestart(); process.exit(0); });

svc.command('stop')
  .description('Stop the Kora service')
  .action(() => { serviceStop(); process.exit(0); });

svc.command('status')
  .description('Show Kora service status')
  .action(() => { serviceStatus(); process.exit(0); });

await program.parseAsync();
