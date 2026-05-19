import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || v === 'replace-me') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(name, fallback) {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  alchemy: {
    apiKey: required('ALCHEMY_API_KEY'),
  },
  discourse: {
    baseUrl: required('DISCOURSE_BASE_URL').replace(/\/+$/, ''),
    apiKey: required('DISCOURSE_API_KEY'),
    apiUsername: optional('DISCOURSE_API_USERNAME', 'system'),
  },
  db: {
    host: optional('DISCOURSE_DB_HOST', '127.0.0.1'),
    port: int('DISCOURSE_DB_PORT', 5432),
    database: optional('DISCOURSE_DB_NAME', 'discourse'),
    user: required('DISCOURSE_DB_USER'),
    password: required('DISCOURSE_DB_PASSWORD'),
  },
  nft: {
    contractAddress: required('NFT_CONTRACT_ADDRESS').toLowerCase(),
    chainId: int('NFT_CHAIN_ID', 1),
  },
  reconcile: {
    enabled: bool('RECONCILE_ENABLED', true),
    intervalMinutes: int('RECONCILE_INTERVAL_MINUTES', 60),
    onBoot: bool('RECONCILE_ON_BOOT', true),
    concurrency: int('RECONCILE_CONCURRENCY', 4),
  },
  chainListener: {
    enabled: bool('CHAIN_LISTENER_ENABLED', true),
    reconnectMinMs: int('CHAIN_LISTENER_RECONNECT_MIN_MS', 2000),
    reconnectMaxMs: int('CHAIN_LISTENER_RECONNECT_MAX_MS', 60000),
  },
  server: {
    port: int('PORT', 3001),
    host: '127.0.0.1',
    adminToken: required('ADMIN_TOKEN'),
    logLevel: optional('LOG_LEVEL', 'info'),
  },
};

// ──────────────────────────────────────────────────────────────────────
// Declarative policy — token IDs on config.nft.contractAddress mapped to
// Discourse group IDs. Edit here when launching a new tier; restart svc.
//
// TODO: fill in the two `null` group IDs once you create the Discourse
// groups for VIP (Bronze) and VIP (Silver). Find the group ID in:
//   Admin → Groups → <group> → URL ends in /g/<name>/<id>, OR
//   psql:  SELECT id, name FROM groups WHERE name IN ('vip-bronze','vip-silver');
// ──────────────────────────────────────────────────────────────────────
export const TOKEN_GROUP_MAP = {
  '11': { groupId: 45, name: 'Governor' },
  '16': { groupId: 42, name: 'VIP (Bronze)' },
  '17': { groupId: 43, name: 'VIP (Silver)' },
  '18': { groupId: 44, name: 'VIP (Gold)' },
};

// Validate the policy at boot — but allow nulls (TODOs) so the service
// can still start and reconcile the configured tiers.
export const ACTIVE_TOKEN_GROUP_MAP = Object.fromEntries(
  Object.entries(TOKEN_GROUP_MAP).filter(([, v]) => Number.isInteger(v.groupId)),
);

export const POLICY_TOKEN_IDS = new Set(Object.keys(TOKEN_GROUP_MAP));
export const ACTIVE_POLICY_TOKEN_IDS = new Set(Object.keys(ACTIVE_TOKEN_GROUP_MAP));
