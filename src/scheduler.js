import { config } from './config.js';
import { logger } from './logger.js';
import { reconcile } from './reconciler.js';

let timer = null;
let running = false;
let lastRunAt = null;
let lastResult = null;

async function runOnce(trigger) {
  if (running) {
    logger.warn('reconcile skipped: previous run still in progress', { trigger });
    return;
  }
  running = true;
  try {
    logger.info('reconcile starting', { trigger });
    lastResult = await reconcile({
      concurrency: config.reconcile.concurrency,
    });
    lastRunAt = new Date().toISOString();
    logger.info('reconcile finished', { trigger, ...lastResult });
  } catch (err) {
    logger.error('reconcile failed', { trigger, error: err.message });
    lastResult = { error: err.message };
    lastRunAt = new Date().toISOString();
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (!config.reconcile.enabled) {
    logger.info('reconcile scheduler disabled (RECONCILE_ENABLED=false)');
    return;
  }
  const intervalMs = config.reconcile.intervalMinutes * 60_000;
  logger.info('reconcile scheduler starting', {
    intervalMinutes: config.reconcile.intervalMinutes,
    onBoot: config.reconcile.onBoot,
    concurrency: config.reconcile.concurrency,
  });

  if (config.reconcile.onBoot) {
    // Small delay so the HTTP server is fully up first.
    setTimeout(() => runOnce('boot'), 3000);
  }
  timer = setInterval(() => runOnce('interval'), intervalMs);
  // Don't keep the process alive solely for this timer during shutdown.
  if (timer.unref) timer.unref();
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function triggerReconcile() {
  // Fire-and-forget; status visible via getSchedulerStatus().
  runOnce('manual');
}

export function getSchedulerStatus() {
  return {
    enabled: config.reconcile.enabled,
    intervalMinutes: config.reconcile.intervalMinutes,
    running,
    lastRunAt,
    lastResult,
  };
}
