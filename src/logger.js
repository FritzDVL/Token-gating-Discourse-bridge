import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.server.logLevel] ?? LEVELS.info;

function emit(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(extra || {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg, extra) => emit('debug', msg, extra),
  info: (msg, extra) => emit('info', msg, extra),
  warn: (msg, extra) => emit('warn', msg, extra),
  error: (msg, extra) => emit('error', msg, extra),
};

// Privacy: redact wallets in non-debug logs to first6+last4 (e.g. 0xabcdef…1234)
export function redactWallet(wallet) {
  if (!wallet || typeof wallet !== 'string') return wallet;
  if (config.server.logLevel === 'debug') return wallet.toLowerCase();
  if (wallet.length < 12) return '***';
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`.toLowerCase();
}
