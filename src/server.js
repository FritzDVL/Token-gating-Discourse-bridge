import express from 'express';
import {
  config,
  TOKEN_GROUP_MAP,
  ACTIVE_TOKEN_GROUP_MAP,
} from './config.js';
import { logger, redactWallet } from './logger.js';
import { findUserByWallet, pingDb, closeDb } from './db.js';
import { makeProvider } from './holdings.js';
import { reconcile, reconcileWalletToken } from './reconciler.js';
import {
  startScheduler,
  stopScheduler,
  triggerReconcile,
  getSchedulerStatus,
} from './scheduler.js';
import {
  startChainListener,
  stopChainListener,
  getChainListenerStatus,
} from './chain-listener.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== config.server.adminToken) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/admin/policy', requireAdmin, (_req, res) => {
  res.json({
    contractAddress: config.nft.contractAddress,
    chainId: config.nft.chainId,
    tokenGroupMap: TOKEN_GROUP_MAP,
    activeTokenGroupMap: ACTIVE_TOKEN_GROUP_MAP,
  });
});

app.get('/admin/status', requireAdmin, (_req, res) => {
  res.json({
    scheduler: getSchedulerStatus(),
    chainListener: getChainListenerStatus(),
  });
});

app.post('/admin/reconcile', requireAdmin, (_req, res) => {
  triggerReconcile();
  res.status(202).json({ status: 'scheduled' });
});

app.get('/admin/holdings', requireAdmin, async (req, res) => {
  const wallet = String(req.query.wallet || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'wallet query param required (0x…40hex)' });
  }
  try {
    const provider = makeProvider();
    const held = await provider.getPolicyTokens(wallet.toLowerCase());
    res.json({
      wallet: redactWallet(wallet),
      provider: provider.name,
      heldTokens: [...held],
      mappedGroups: [...held].map((t) => ACTIVE_TOKEN_GROUP_MAP[t]).filter(Boolean),
    });
  } catch (err) {
    logger.error('admin holdings failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/dryrun', requireAdmin, async (req, res) => {
  const wallet = String(req.query.wallet || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'wallet query param required (0x…40hex)' });
  }
  try {
    const user = await findUserByWallet(wallet);
    const provider = makeProvider();
    const held = await provider.getPolicyTokens(wallet.toLowerCase());
    const plans = [];
    for (const tokenId of Object.keys(ACTIVE_TOKEN_GROUP_MAP)) {
      const m = ACTIVE_TOKEN_GROUP_MAP[tokenId];
      plans.push({
        tokenId,
        groupId: m.groupId,
        groupName: m.name,
        wouldAction: held.has(tokenId) ? 'grant' : 'revoke',
        forumLinked: Boolean(user),
      });
    }
    res.json({
      wallet: redactWallet(wallet),
      forumUser: user,
      heldTokens: [...held],
      plans,
    });
  } catch (err) {
    logger.error('dryrun failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/reconcile/dryrun', requireAdmin, async (_req, res) => {
  try {
    const result = await reconcile({
      dryRun: true,
      concurrency: config.reconcile.concurrency,
    });
    res.json(result);
  } catch (err) {
    logger.error('full dryrun failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Manual single-wallet reapply — useful for support tickets ("Alice says she
// minted but isn't in the group"). Triggers the same code path as the
// real-time listener.
app.post('/admin/reapply', requireAdmin, async (req, res) => {
  const wallet = String(req.body?.wallet || req.query.wallet || '').trim().toLowerCase();
  const tokenId = String(req.body?.tokenId || req.query.tokenId || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || !tokenId) {
    return res.status(400).json({ error: 'wallet and tokenId required' });
  }
  try {
    const result = await reconcileWalletToken({ wallet, tokenId });
    res.json(result);
  } catch (err) {
    logger.error('reapply failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, _req, res, _next) => {
  logger.error('unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(config.server.port, config.server.host, async () => {
  logger.info('listening', {
    host: config.server.host,
    port: config.server.port,
    logLevel: config.server.logLevel,
  });
  try {
    await pingDb();
    logger.info('db reachable');
  } catch (err) {
    logger.error('db NOT reachable at startup', { error: err.message });
  }
  startScheduler();
  startChainListener().catch((err) => {
    logger.error('chain listener startup failed', { error: err.message });
  });
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  stopScheduler();
  stopChainListener().catch(() => {});
  server.close(async () => {
    try { await closeDb(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
