import { config } from './config.js';
import { logger } from './logger.js';

function headers() {
  return {
    'Api-Key': config.discourse.apiKey,
    'Api-Username': config.discourse.apiUsername,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function call(method, path, body) {
  const url = `${config.discourse.baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  logger.debug('discourse api', { method, path, status: res.status });
  return { status: res.status, body: parsed };
}

/**
 * List all current members of a Discourse group. Paginated.
 * Returns [{ id, username }, …]
 */
export async function listGroupMembers(groupId) {
  const out = [];
  const limit = 100;
  let offset = 0;
  // Hard ceiling so a bug can't loop forever.
  for (let page = 0; page < 1000; page++) {
    const r = await call(
      'GET',
      `/groups/${groupId}/members.json?limit=${limit}&offset=${offset}`,
    );
    if (r.status === 404) break;
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(`Discourse list-members failed (${r.status})`);
      err.status = r.status;
      err.body = r.body;
      throw err;
    }
    const members = Array.isArray(r.body?.members) ? r.body.members : [];
    for (const m of members) {
      out.push({ id: m.id, username: m.username });
    }
    if (members.length < limit) break;
    offset += limit;
  }
  return out;
}

/**
 * Add a user to a Discourse group by username.
 * Idempotent: 422 "already a member" is treated as success.
 */
export async function addUserToGroup({ groupId, username }) {
  const r = await call('PUT', `/groups/${groupId}/members.json`, {
    usernames: username,
  });
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, alreadyMember: false, status: r.status };
  }
  if (r.status === 422) {
    // Already a member, or similar idempotent no-op.
    return { ok: true, alreadyMember: true, status: r.status, body: r.body };
  }
  const err = new Error(`Discourse add-member failed (${r.status})`);
  err.status = r.status;
  err.body = r.body;
  throw err;
}

/**
 * Remove a user from a Discourse group by user id.
 * Idempotent: not-a-member responses are treated as success.
 */
export async function removeUserFromGroup({ groupId, userId }) {
  const r = await call(
    'DELETE',
    `/groups/${groupId}/members.json`,
    { user_id: userId },
  );
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, wasMember: true, status: r.status };
  }
  if (r.status === 422 || r.status === 404) {
    return { ok: true, wasMember: false, status: r.status, body: r.body };
  }
  const err = new Error(`Discourse remove-member failed (${r.status})`);
  err.status = r.status;
  err.body = r.body;
  throw err;
}
