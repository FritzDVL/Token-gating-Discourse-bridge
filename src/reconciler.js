import { ACTIVE_TOKEN_GROUP_MAP, TOKEN_GROUP_MAP } from './config.js';
import { listAllSiweWallets, findUserByWallet } from './db.js';
import { listGroupMembers, addUserToGroup, removeUserFromGroup } from './discourse.js';
import { makeProvider } from './holdings.js';
import { logger, redactWallet } from './logger.js';

// ─────────── Per-wallet serialization ───────────
// The hourly reconciler and the real-time chain listener can both touch
// the same (wallet, group) at the same time. To avoid one undoing the
// other's change mid-flight, serialize ALL group mutations through a
// per-wallet lock. (Discourse calls are idempotent, but ordering matters:
// a stale `remove` arriving after a fresh `add` would still revoke.)
const walletLocks = new Map(); // wallet -> Promise

export async function withWalletLock(wallet, fn) {
  const key = (wallet || '').toLowerCase();
  const prev = walletLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of prev outcome
  // Tail of the chain — next caller waits on this (settled either way).
  const tail = run.catch(() => {});
  walletLocks.set(key, tail);
  // GC: if no one else queued behind us by the time we're done, drop entry.
  tail.then(() => {
    if (walletLocks.get(key) === tail) walletLocks.delete(key);
  });
  return run;
}

/**
 * Bounded-concurrency map for the fallback per-wallet path.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (err) {
        results[idx] = { ok: false, error: err };
      }
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Full reconciliation cycle. Used by the scheduler and the manual CLI.
 *
 * 1. List every SIWE-linked forum user.
 * 2. Ask the provider for their holdings (batched if the provider supports it).
 * 3. For each (token → group) in the ACTIVE policy:
 *      desired = SIWE-linked usernames holding that token
 *      current = usernames in the Discourse group
 *      → ADD anyone in desired but not current
 *      → REMOVE anyone in current ∩ siwe-linked but not desired
 *        (members not SIWE-linked are NEVER touched — admins are safe)
 */
export async function reconcile({ dryRun = false, concurrency = 4 } = {}) {
  const startedAt = Date.now();
  const provider = makeProvider();

  // Warn (don't fail) about tiers that aren't yet wired up.
  const inactive = Object.entries(TOKEN_GROUP_MAP)
    .filter(([, v]) => !Number.isInteger(v.groupId))
    .map(([tid, v]) => ({ tokenId: tid, name: v.name }));
  if (inactive.length) {
    logger.warn('reconcile: tiers without group id are skipped', { inactive });
  }

  const wallets = await listAllSiweWallets();
  logger.info('reconcile: wallets loaded', {
    count: wallets.length,
    provider: provider.name,
    activeTiers: Object.keys(ACTIVE_TOKEN_GROUP_MAP),
    dryRun,
  });

  if (wallets.length === 0) {
    return summary({ startedAt, wallets: 0, dryRun, perToken: [] });
  }

  // Step 1: fetch holdings. Prefer the batch API when the provider has one.
  let holdings;       // Map<wallet, Set<tokenId>>
  let lookupFailures = 0;
  if (typeof provider.getPolicyTokensBatch === 'function') {
    try {
      holdings = await provider.getPolicyTokensBatch(wallets.map((w) => w.wallet));
    } catch (err) {
      logger.error('reconcile: batch holdings lookup failed', { error: err.message });
      throw err;
    }
  } else {
    holdings = new Map();
    const results = await mapWithConcurrency(
      wallets,
      concurrency,
      async (w) => provider.getPolicyTokens(w.wallet),
    );
    for (let idx = 0; idx < wallets.length; idx++) {
      const r = results[idx];
      if (r.ok) {
        holdings.set(wallets[idx].wallet, r.value);
      } else {
        lookupFailures++;
        logger.warn('reconcile: holdings lookup failed', {
          wallet: redactWallet(wallets[idx].wallet),
          error: r.error.message,
          status: r.error.status,
        });
      }
    }
  }

  const siweUsernames = new Set(wallets.map((w) => w.username));
  const usernameByWallet = new Map(wallets.map((w) => [w.wallet, w.username]));

  // Step 2: per-group diff and apply.
  const perToken = [];
  for (const [tokenId, mapping] of Object.entries(ACTIVE_TOKEN_GROUP_MAP)) {
    const desired = new Set();
    for (const [wallet, tokens] of holdings) {
      if (tokens.has(tokenId)) {
        const username = usernameByWallet.get(wallet);
        if (username) desired.add(username);
      }
    }

    let current;
    try {
      current = await listGroupMembers(mapping.groupId);
    } catch (err) {
      logger.error('reconcile: failed to list group members', {
        groupId: mapping.groupId,
        groupName: mapping.name,
        error: err.message,
      });
      perToken.push({
        tokenId,
        groupId: mapping.groupId,
        groupName: mapping.name,
        error: err.message,
      });
      continue;
    }
    const currentUsernames = new Set(current.map((m) => m.username));

    const toAdd = [...desired].filter((u) => !currentUsernames.has(u));
    const toRemove = current.filter(
      (m) => siweUsernames.has(m.username) && !desired.has(m.username),
    );

    logger.info('reconcile: diff computed', {
      tokenId,
      groupId: mapping.groupId,
      groupName: mapping.name,
      desired: desired.size,
      current: currentUsernames.size,
      toAdd: toAdd.length,
      toRemove: toRemove.length,
      dryRun,
    });

    if (dryRun) {
      perToken.push({
        tokenId,
        groupId: mapping.groupId,
        groupName: mapping.name,
        desiredCount: desired.size,
        currentCount: currentUsernames.size,
        toAdd,
        toRemove: toRemove.map((m) => m.username),
        applied: { added: 0, removed: 0, errors: 0 },
      });
      continue;
    }

    let added = 0, removed = 0, errors = 0;
    for (const username of toAdd) {
      try {
        await addUserToGroup({ groupId: mapping.groupId, username });
        added++;
      } catch (err) {
        errors++;
        logger.error('reconcile: add failed', {
          groupId: mapping.groupId, username, error: err.message,
        });
      }
    }
    for (const member of toRemove) {
      try {
        await removeUserFromGroup({ groupId: mapping.groupId, userId: member.id });
        removed++;
      } catch (err) {
        errors++;
        logger.error('reconcile: remove failed', {
          groupId: mapping.groupId, username: member.username, error: err.message,
        });
      }
    }

    perToken.push({
      tokenId,
      groupId: mapping.groupId,
      groupName: mapping.name,
      desiredCount: desired.size,
      currentCount: currentUsernames.size,
      applied: { added, removed, errors },
    });
  }

  return summary({
    startedAt,
    wallets: wallets.length,
    lookupFailures,
    dryRun,
    perToken,
  });
}

/**
 * React to a single (wallet, tokenId) change, e.g. from the chain listener.
 *
 * Looks up the wallet → forum user; if SIWE-linked and the token is in the
 * active policy, reads the current on-chain balance via the provider and
 * grants/revokes group membership accordingly. Idempotent.
 */
export async function reconcileWalletToken({ wallet, tokenId }) {
  const mapping = ACTIVE_TOKEN_GROUP_MAP[tokenId];
  if (!mapping) {
    return { status: 'ignored', reason: 'token-not-in-policy', tokenId };
  }
  const user = await findUserByWallet(wallet);
  if (!user) {
    return { status: 'ignored', reason: 'wallet-not-linked' };
  }

  // Serialize all mutations for this wallet so a stale revoke from one
  // transfer can't undo a fresh grant from a later transfer in the same
  // block.
  return withWalletLock(wallet, async () => {
    const provider = makeProvider();
    const held = await provider.getPolicyTokens(wallet);
    const hasToken = held.has(tokenId);

    if (hasToken) {
      const r = await addUserToGroup({
        groupId: mapping.groupId,
        username: user.username,
      });
      logger.info('listener: granted', {
        wallet: redactWallet(wallet),
        tokenId,
        groupId: mapping.groupId,
        username: user.username,
        alreadyMember: r.alreadyMember,
      });
      return { status: 'ok', action: 'grant', tokenId, alreadyMember: r.alreadyMember };
    } else {
      const r = await removeUserFromGroup({
        groupId: mapping.groupId,
        userId: user.userId,
      });
      logger.info('listener: revoked', {
        wallet: redactWallet(wallet),
        tokenId,
        groupId: mapping.groupId,
        username: user.username,
        wasMember: r.wasMember,
      });
      return { status: 'ok', action: 'revoke', tokenId, wasMember: r.wasMember };
    }
  });
}

function summary(s) {
  return { ...s, durationMs: Date.now() - s.startedAt };
}
