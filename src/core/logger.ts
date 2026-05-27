import chalk from 'chalk';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export const logger = {
  get currentLevel(): LogLevel {
    return currentLevel;
  },

  setLevel(level: LogLevel) {
    currentLevel = level;
  },

  debug(scope: string, msg: string, ...args: unknown[]) {
    if (!shouldLog('debug')) return;
    console.log(chalk.gray(`[${timestamp()}] [DEBUG] [${scope}]`), msg, ...args);
  },

  info(scope: string, msg: string, ...args: unknown[]) {
    if (!shouldLog('info')) return;
    console.log(chalk.blue(`[${timestamp()}] [INFO]  [${scope}]`), msg, ...args);
  },

  warn(scope: string, msg: string, ...args: unknown[]) {
    if (!shouldLog('warn')) return;
    console.warn(chalk.yellow(`[${timestamp()}] [WARN]  [${scope}]`), msg, ...args);
  },

  error(scope: string, msg: string, ...args: unknown[]) {
    if (!shouldLog('error')) return;
    console.error(chalk.red(`[${timestamp()}] [ERROR] [${scope}]`), msg, ...args);
  },
};
