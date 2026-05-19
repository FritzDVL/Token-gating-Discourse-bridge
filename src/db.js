import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 4,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  logger.error('pg pool error', { error: err.message });
});

/**
 * Look up a single Discourse user by their SIWE wallet address.
 *
 * See README ("Wallet → User mapping") for the rationale. Returns
 * { userId, username } or null when the wallet has never logged in.
 */
export async function findUserByWallet(wallet) {
  if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }
  const sql = `
    SELECT u.id AS user_id, u.username
    FROM user_associated_accounts uaa
    JOIN users u ON u.id = uaa.user_id
    WHERE uaa.provider_name = 'siwe'
      AND lower(uaa.provider_uid) = lower($1)
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [wallet]);
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, username: rows[0].username };
}

/**
 * List every forum user who has linked a wallet via SIWE.
 * The reconciler walks this list on every cycle.
 *
 * Returns: [{ wallet, userId, username }, …]   (wallet lowercased)
 */
export async function listAllSiweWallets() {
  const sql = `
    SELECT lower(uaa.provider_uid) AS wallet,
           u.id   AS user_id,
           u.username
    FROM user_associated_accounts uaa
    JOIN users u ON u.id = uaa.user_id
    WHERE uaa.provider_name = 'siwe'
      AND u.active = true
      AND u.suspended_till IS NULL
  `;
  const { rows } = await pool.query(sql);
  return rows.map((r) => ({
    wallet: r.wallet,
    userId: r.user_id,
    username: r.username,
  }));
}

export async function pingDb() {
  await pool.query('SELECT 1');
}

export async function closeDb() {
  await pool.end();
}
