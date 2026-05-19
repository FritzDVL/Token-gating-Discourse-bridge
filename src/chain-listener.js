import { ethers } from 'ethers';
import { config, ACTIVE_POLICY_TOKEN_IDS } from './config.js';
import { logger, redactWallet } from './logger.js';
import { ERC1155_ABI } from './providers/alchemy.js';
import { reconcileWalletToken } from './reconciler.js';
import { findUserByWallet } from './db.js';

let ws = null;
let contract = null;
let reconnectAttempts = 0;
let stopped = false;
let heartbeatTimer = null;
let status = {
  connected: false,
  lastEventAt: null,
  eventsHandled: 0,
  errors: 0,
  lastHeartbeatAt: null,
  lastBlockNumber: null,
};

// How often to probe the WS by asking for the current block. ethers v6's
// WebSocketProvider doesn't surface every dead-connection mode through
// the 'close' event, so we belt-and-suspender it with a heartbeat.
const HEARTBEAT_MS = 30_000;

function wsUrl() {
  return `wss://eth-mainnet.g.alchemy.com/v2/${config.alchemy.apiKey}`;
}

function backoffMs() {
  const { reconnectMinMs, reconnectMaxMs } = config.chainListener;
  // Exponential backoff with jitter, capped at the configured max.
  const exp = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** reconnectAttempts);
  return Math.floor(exp * (0.7 + Math.random() * 0.6));
}

/**
 * Quick local prefilter: is at least one of the affected wallets actually
 * a SIWE-linked forum user? If not, drop the event with zero RPC/work.
 */
async function anyWalletIsLinked(wallets) {
  for (const w of wallets) {
    if (!w || w === ethers.ZeroAddress) continue;
    const user = await findUserByWallet(w);
    if (user) return true;
  }
  return false;
}

async function handleTransfer({ from, to, tokenId, txHash }) {
  if (!ACTIVE_POLICY_TOKEN_IDS.has(tokenId)) return;

  const wallets = [from, to].filter(
    (w) => w && w.toLowerCase() !== ethers.ZeroAddress,
  ).map((w) => w.toLowerCase());

  // Fast path: skip the whole event if neither party is on the forum.
  if (!(await anyWalletIsLinked(wallets))) {
    logger.debug('listener: no linked wallet, skip', {
      tokenId, txHash, wallets: wallets.map(redactWallet),
    });
    return;
  }

  for (const wallet of wallets) {
    try {
      await reconcileWalletToken({ wallet, tokenId });
      status.eventsHandled++;
    } catch (err) {
      status.errors++;
      logger.error('listener: reconcileWalletToken failed', {
        wallet: redactWallet(wallet),
        tokenId,
        txHash,
        error: err.message,
      });
    }
  }
  status.lastEventAt = new Date().toISOString();
}

function attachListeners() {
  contract.on('TransferSingle', async (_op, from, to, id, _value, evt) => {
    const tokenId = id.toString();
    logger.info('listener: TransferSingle', {
      from: redactWallet(from),
      to: redactWallet(to),
      tokenId,
      txHash: evt?.log?.transactionHash,
    });
    await handleTransfer({
      from, to, tokenId, txHash: evt?.log?.transactionHash,
    });
  });

  contract.on('TransferBatch', async (_op, from, to, ids, _values, evt) => {
    logger.info('listener: TransferBatch', {
      from: redactWallet(from),
      to: redactWallet(to),
      tokenIds: ids.map((i) => i.toString()),
      txHash: evt?.log?.transactionHash,
    });
    for (const id of ids) {
      await handleTransfer({
        from, to, tokenId: id.toString(), txHash: evt?.log?.transactionHash,
      });
    }
  });
}

async function connect() {
  if (stopped) return;
  try {
    ws = new ethers.WebSocketProvider(wsUrl());
    contract = new ethers.Contract(config.nft.contractAddress, ERC1155_ABI, ws);

    // ethers v6 doesn't expose ws lifecycle directly on the provider;
    // we tap into the underlying socket if available.
    const sock = ws._websocket || ws.websocket;
    if (sock) {
      sock.addEventListener?.('close', onSocketClose);
      sock.addEventListener?.('error', (e) => {
        logger.warn('listener: socket error', { error: e?.message || String(e) });
      });
    }

    // Sanity ping: ask for the current block. If this works, we're up.
    const blockNumber = await ws.getBlockNumber();
    attachListeners();
    status.connected = true;
    status.lastBlockNumber = blockNumber;
    status.lastHeartbeatAt = new Date().toISOString();
    reconnectAttempts = 0;
    startHeartbeat();
    logger.info('listener: connected', {
      contract: config.nft.contractAddress,
      tokens: [...ACTIVE_POLICY_TOKEN_IDS],
      blockNumber,
    });
  } catch (err) {
    logger.error('listener: connect failed', { error: err.message });
    scheduleReconnect();
  }
}

function onSocketClose() {
  if (stopped) return;
  status.connected = false;
  logger.warn('listener: socket closed, will reconnect');
  scheduleReconnect();
}

function scheduleReconnect() {
  if (stopped) return;
  const delay = backoffMs();
  reconnectAttempts++;
  logger.info('listener: scheduling reconnect', { delayMs: delay, attempt: reconnectAttempts });
  setTimeout(() => {
    cleanup().finally(connect);
  }, delay).unref?.();
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!ws || stopped) return;
    try {
      const bn = await ws.getBlockNumber();
      status.lastHeartbeatAt = new Date().toISOString();
      status.lastBlockNumber = bn;
    } catch (err) {
      logger.warn('listener: heartbeat failed, reconnecting', { error: err.message });
      status.connected = false;
      stopHeartbeat();
      scheduleReconnect();
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function cleanup() {
  stopHeartbeat();
  try { if (contract) contract.removeAllListeners(); } catch {}
  try { if (ws) await ws.destroy(); } catch {}
  contract = null;
  ws = null;
}

export async function startChainListener() {
  if (!config.chainListener.enabled) {
    logger.info('chain listener disabled (CHAIN_LISTENER_ENABLED=false)');
    return;
  }
  if (ACTIVE_POLICY_TOKEN_IDS.size === 0) {
    logger.warn('chain listener: no active tokens in policy, not connecting');
    return;
  }
  stopped = false;
  await connect();
}

export async function stopChainListener() {
  stopped = true;
  await cleanup();
  status.connected = false;
}

export function getChainListenerStatus() {
  return {
    enabled: config.chainListener.enabled,
    contract: config.nft.contractAddress,
    tokens: [...ACTIVE_POLICY_TOKEN_IDS],
    ...status,
  };
}
