# Token-gating Discourse Bridge

A small Node.js service that keeps Discourse group memberships in sync with
NFT ownership on Ethereum. Reads the chain directly via Alchemy — no third
party in the critical path.

It does one thing: figure out which forum users currently hold which
tokens of a single ERC-1155 contract, and make the Discourse groups
match. It does **not** handle login (that's `discourse-siwe-auth`), wallet
connection, or any UI.

---

## How it works

```
              ┌──────────────────────────────────────────────┐
              │  Real-time WebSocket listener (Alchemy)      │
   transfer → │  TransferSingle / TransferBatch events       │ ── instant
   on-chain   │  → re-check affected wallets → update groups │
              └──────────────────────────────────────────────┘
                                  +
              ┌──────────────────────────────────────────────┐
              │  Hourly safety-net reconciler                │
              │  walks all SIWE-linked wallets, batched      │ ── eventual
              │  balanceOfBatch → diffs vs Discourse groups  │    correctness
              └──────────────────────────────────────────────┘
```

This is the **Stripe pattern**: a fast push channel for low latency, and a
periodic full reconciliation for correctness. If the WebSocket drops for
a minute, the reconciler catches up. If you redeploy mid-cycle,
the reconciler catches up. If a single event fails, the reconciler catches
up. The two layers compensate for each other's failure modes.

**Two important safety properties:**

- The reconciler only ever *removes* a user from a group if that user is
  **SIWE-linked**. Admins, moderators, and anyone you added manually stay
  put no matter what the chain says.
- Every Discourse API call is **idempotent** — re-running is always safe.

---

## Wallet → forum-user lookup

The forum uses `discourse-siwe-auth` for Sign-In with Ethereum. When a user
signs the SIWE message, that plugin stores the wallet in Discourse's
standard `user_associated_accounts` table:

| column           | value                          |
|------------------|--------------------------------|
| `provider_name`  | `'siwe'`                       |
| `provider_uid`   | `'<lowercase wallet address>'` |
| `user_id`        | `<Discourse user id>`          |

The bridge resolves wallets via one SQL query against that table (read-only
role, two `SELECT`s, two tables — that's it). If a wallet has never logged
into the forum, it's silently skipped — not an error, just "this NFT
holder hasn't connected their account yet."

That's why Step 5 below creates a dedicated read-only Postgres role and
exposes Discourse's database on `127.0.0.1:5432`. There's no other source
for this mapping — Discourse's REST API doesn't expose associated accounts.

---

## Token → Group policy

In `src/config.js`:

```js
export const TOKEN_GROUP_MAP = {
  '11': { groupId: 41,   name: 'Governor' },
  '16': { groupId: null, name: 'VIP (Bronze)' }, // TODO: create group, set id
  '17': { groupId: null, name: 'VIP (Silver)' }, // TODO: create group, set id
  '18': { groupId: 42,   name: 'VIP (Gold)' },
};
```

Tiers with `groupId: null` are visible in `/admin/policy` but skipped by
the reconciler and listener until you fill in a real group ID.

The contract these token IDs live on is set via `NFT_CONTRACT_ADDRESS` in
`.env`. All four tokens are assumed to live on the same contract.

---

## Endpoints

| Method | Path                              | Auth                 | Purpose                                         |
|-------:|-----------------------------------|----------------------|-------------------------------------------------|
| GET    | `/healthz`                        | none                 | Liveness for nginx / uptime                     |
| GET    | `/admin/policy`                   | `Bearer ADMIN_TOKEN` | Active token→group map                          |
| GET    | `/admin/status`                   | `Bearer ADMIN_TOKEN` | Scheduler + listener status                     |
| POST   | `/admin/reconcile`                | `Bearer ADMIN_TOKEN` | Trigger a reconcile now (fire-and-forget)       |
| POST   | `/admin/reconcile/dryrun`         | `Bearer ADMIN_TOKEN` | Full diff, apply nothing                        |
| GET    | `/admin/holdings?wallet=0x…`      | `Bearer ADMIN_TOKEN` | Live balance for one wallet                     |
| GET    | `/admin/dryrun?wallet=0x…`        | `Bearer ADMIN_TOKEN` | Single-wallet "what would happen"               |
| POST   | `/admin/reapply`                  | `Bearer ADMIN_TOKEN` | Re-run the listener path for one (wallet, token)|

Binds to `127.0.0.1:3001`. Only nginx (if you set it up) talks to it from
outside, and only for `/healthz`. Admin routes are reached via SSH tunnel.

---

# Step-by-step VPS setup

### Step 0 — What you need

- SSH access to the VPS as `root` (or a sudoer)
- Discourse already running via `/var/discourse/launcher`
- `discourse-siwe-auth` plugin installed and people have actually signed in
  with their wallets at least once (otherwise there's nothing to sync)
- An **Alchemy API key** (Step 1)
- The **full 42-char NFT contract address** (Step 2)
- Node.js 20+ installed:

  ```bash
  node --version    # v20.x or higher
  # If missing:
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

### Step 1 — Get an Alchemy API key (free, 2 minutes)

1. Go to [alchemy.com](https://alchemy.com) → Sign up. No credit card.
2. Create an app: **Chain = Ethereum**, **Network = Mainnet**. Name it
   whatever ("societyprotocol-bridge").
3. Open the app → copy its API key. It's the last segment of the HTTPS URL:
   `https://eth-mainnet.g.alchemy.com/v2/`**`<this part>`**.

Save it for Step 6 (`ALCHEMY_API_KEY`).

### Step 2 — Get the full contract address

The full 42-character address goes into `NFT_CONTRACT_ADDRESS`. Look it up
on [etherscan.io](https://etherscan.io) and copy the full address from the
URL bar (or from any minting page you control).

### Step 3 — Create the two missing Discourse groups

For VIP (Bronze) and VIP (Silver):

1. **Admin → Groups → New Group**, name `vip-bronze`, full name "VIP (Bronze)".
2. Repeat for `vip-silver` / "VIP (Silver)".
3. Find each group's numeric **ID**. Easiest way:
   ```bash
   sudo -i
   cd /var/discourse && ./launcher enter app
   su - postgres -c "psql -d discourse -c \"SELECT id, name FROM groups WHERE name IN ('vip-bronze','vip-silver');\""
   ```
4. Paste the two IDs into `src/config.js`:
   ```js
   '16': { groupId: 43, name: 'VIP (Bronze)' },  // ← was null
   '17': { groupId: 44, name: 'VIP (Silver)' },  // ← was null
   ```

(You can also defer this — the bridge runs fine with only Governor + Gold
active. The two pending tiers are listed in `/admin/policy` as TODO.)

### Step 4 — Clone the repo and install deps

```bash
sudo useradd --system --home /opt/token-gating-discourse-bridge --shell /usr/sbin/nologin tgbridge
sudo mkdir -p /opt/token-gating-discourse-bridge
sudo chown tgbridge:tgbridge /opt/token-gating-discourse-bridge
sudo -u tgbridge git clone https://github.com/FritzDVL/Token-gating-Discourse-bridge.git /opt/token-gating-discourse-bridge
cd /opt/token-gating-discourse-bridge
sudo -u tgbridge npm install --omit=dev
```

### Step 5 — Create the read-only Postgres role + expose port

```bash
openssl rand -base64 32        # generate password, save it
sudo -i
cd /var/discourse
./launcher enter app
su - postgres -c "psql discourse"
```

```sql
CREATE ROLE tg_bridge_ro LOGIN PASSWORD 'PASTE_PASSWORD_HERE';
GRANT CONNECT ON DATABASE discourse TO tg_bridge_ro;
GRANT USAGE  ON SCHEMA public        TO tg_bridge_ro;
GRANT SELECT ON public.user_associated_accounts TO tg_bridge_ro;
GRANT SELECT ON public.users                    TO tg_bridge_ro;
\q
```

Exit the container, then expose Postgres to the host loopback:

```bash
sudo nano /var/discourse/containers/app.yml
```

In the `expose:` section, add:

```yaml
  - "127.0.0.1:5432:5432"
```

The `127.0.0.1:` prefix keeps Postgres off the public internet. Then:

```bash
sudo /var/discourse/launcher rebuild app    # 5–10 min, forum briefly offline
sudo ss -tlnp | grep 5432                   # confirm: 127.0.0.1:5432 LISTEN
```

### Step 6 — Create the Discourse API key

In the forum, signed in as an admin:

**Admin → API → API Keys → + New API Key**

- Description: `tg-bridge`
- User Level: **Single User**, user `system`
- Scope: **Granular**, with these checked:
  - `groups#add_members`
  - `groups#remove_member`
  - `groups#show`
  - `users#show`
  - **`read`** ← this is the one that's easy to miss. Discourse has no
    dedicated "list group members" granular scope, so `GET /groups/{id}/members.json`
    falls under the generic `read` scope. Without it, the reconciler gets
    `403 Forbidden` when trying to list current group members.

Save. Copy the key (shown once).

> Why not just use a Global key? You can — it works — but Granular + the
> five scopes above gives the bridge exactly the access it needs and
> nothing else. If a Global key leaks, an attacker can do anything on the
> forum as `system`. With the granular key above, the worst case is they
> can read/edit group memberships and read user info.

### Step 7 — Fill the env file

```bash
sudo cp /opt/token-gating-discourse-bridge/.env.example /etc/token-gating-discourse-bridge.env
sudo nano /etc/token-gating-discourse-bridge.env
```

| Variable                  | From                              |
|---------------------------|-----------------------------------|
| `ALCHEMY_API_KEY`         | Step 1                            |
| `NFT_CONTRACT_ADDRESS`    | Step 2                            |
| `DISCOURSE_API_KEY`       | Step 6                            |
| `DISCOURSE_DB_PASSWORD`   | Step 5                            |
| `ADMIN_TOKEN`             | `openssl rand -hex 32`            |

Then:

```bash
sudo chown root:tgbridge /etc/token-gating-discourse-bridge.env
sudo chmod 0640 /etc/token-gating-discourse-bridge.env
```

### Step 8 — Verify before launching

Run these in order. Stop at the first failure and fix it before moving on.

```bash
# 8a. DB connectivity + wallet lookup
sudo -u tgbridge --preserve-env bash -c \
  'set -a; . /etc/token-gating-discourse-bridge.env; set +a; \
   cd /opt/token-gating-discourse-bridge && \
   npm run test:lookup -- 0xYourWalletThatLoggedIntoTheForum'
# Expect: {"wallet":"…","found":true,"userId":…,"username":"…"}

# 8b. Direct chain read via Alchemy
sudo -u tgbridge --preserve-env bash -c \
  'set -a; . /etc/token-gating-discourse-bridge.env; set +a; \
   cd /opt/token-gating-discourse-bridge && \
   npm run test:holdings -- 0xYourWallet'
# Expect: {"wallet":"…","provider":"alchemy","heldPolicyTokens":["11"]}

# 8c. Full dry-run reconcile — preview the diff, change nothing
sudo -u tgbridge --preserve-env bash -c \
  'set -a; . /etc/token-gating-discourse-bridge.env; set +a; \
   cd /opt/token-gating-discourse-bridge && \
   npm run reconcile -- --dry'
```

### Step 9 — Install the systemd unit

```bash
sudo cp /opt/token-gating-discourse-bridge/systemd/token-gating-discourse-bridge.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now token-gating-discourse-bridge
sudo systemctl status token-gating-discourse-bridge
journalctl -u token-gating-discourse-bridge -f
```

Within ~30 seconds you should see:
- `"listening"` (HTTP server up)
- `"db reachable"`
- `"listener: connected"` (WebSocket to Alchemy live)
- `"reconcile finished"` (boot-time reconcile)

### Step 10 — (Optional) Public health endpoint via nginx

Only needed if you want an external uptime monitor (UptimeRobot, etc) to
hit a `/healthz`. The bridge does not need any public HTTP endpoint to
work — it only makes outbound connections.

```bash
sudo cp /opt/token-gating-discourse-bridge/nginx/token-gating-discourse-bridge.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

### Day-to-day

```bash
journalctl -u token-gating-discourse-bridge -f                  # live logs

curl http://127.0.0.1:3001/admin/status \                       # current state
     -H "Authorization: Bearer $ADMIN_TOKEN" | jq

curl -X POST http://127.0.0.1:3001/admin/reconcile \            # force a cycle now
     -H "Authorization: Bearer $ADMIN_TOKEN"

curl "http://127.0.0.1:3001/admin/holdings?wallet=0xABC…" \     # what does this wallet hold?
     -H "Authorization: Bearer $ADMIN_TOKEN" | jq

sudo systemctl restart token-gating-discourse-bridge            # after editing /etc/…env
```

From your laptop you can tunnel the admin port:

```bash
ssh -L 3001:127.0.0.1:3001 root@forum.societyprotocol.io
```

### Updating

```bash
cd /opt/token-gating-discourse-bridge
sudo -u tgbridge git pull
sudo -u tgbridge npm install --omit=dev
sudo systemctl restart token-gating-discourse-bridge
```

---

## Logs & privacy

- Plain JSON-per-line to stdout; systemd journal captures it.
- Wallet addresses redacted to `0x123456…7890` unless `LOG_LEVEL=debug`.
- Every transfer, reconcile, and Discourse change is logged.

---

## Troubleshooting

| Symptom                                                  | Fix                                                                          |
|----------------------------------------------------------|------------------------------------------------------------------------------|
| `db NOT reachable at startup`                            | Step 5 — Postgres not exposed on `127.0.0.1:5432`.                           |
| `password authentication failed for user "tg_bridge_ro"` | Wrong password in `.env`, or `CREATE ROLE` skipped.                          |
| `relation "user_associated_accounts" does not exist`     | Wrong DB, or SIWE plugin never ran on this forum.                            |
| `listener: connect failed`                               | Wrong `ALCHEMY_API_KEY`, or no outbound 443/wss from VPS.                    |
| `holdings lookup failed: missing revert data`            | `NFT_CONTRACT_ADDRESS` is wrong or not an ERC-1155.                          |
| `Discourse add-member failed (403)`                      | API key missing scope, or `Api-Username` isn't an admin.                     |
| `Discourse add-member failed (404)`                      | Group ID in `TOKEN_GROUP_MAP` doesn't exist on the forum.                    |
| `reconcile: tiers without group id are skipped`          | Expected for Bronze/Silver until step 3 done. Fill in `src/config.js`.       |
| `reconcile skipped: previous run still in progress`      | Cycle is taking longer than the interval. Raise `RECONCILE_INTERVAL_MINUTES`.|

---

## Project layout

```
token-gating-discourse-bridge/
├── src/
│   ├── server.js              # Express app, admin routes, startup/shutdown
│   ├── config.js              # env + TOKEN_GROUP_MAP
│   ├── scheduler.js           # On-boot + interval reconcile loop
│   ├── reconciler.js          # Full diff-and-apply + per-event flow + wallet lock
│   ├── chain-listener.js      # WebSocket TransferSingle/Batch subscription
│   ├── holdings.js            # Provider dispatcher (currently just Alchemy)
│   ├── providers/
│   │   └── alchemy.js         # Direct chain reads via balanceOfBatch
│   ├── discourse.js           # Discourse admin API client
│   ├── db.js                  # Read-only Postgres
│   └── logger.js              # Structured JSON logs + redaction
├── scripts/
│   ├── reconcile-once.js
│   ├── test-lookup.js
│   ├── test-holdings.js
│   └── test-dryrun-grant.js
├── systemd/token-gating-discourse-bridge.service
├── nginx/token-gating-discourse-bridge.conf
├── .env.example
└── package.json
```
