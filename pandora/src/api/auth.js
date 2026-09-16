import { get, run } from '../db.js';
import { newId, newApiKey, hashKey, safeEqual } from '../lib/id.js';
import { config } from '../config.js';

/**
 * Authentication, deliberately boring.
 *
 * A subscriber presents `Authorization: Bearer pnd_…`. We hash it and look
 * the hash up. We never store the key itself, so a leak of the database is
 * not a leak of anyone's credentials — and it means nobody, including us,
 * can recover a lost key. That is the correct trade.
 */

export function createSubscriber({ name, kind = 'agent', isAdmin = false, key = null }) {
  const apiKey = key ?? newApiKey();
  const id = newId('sub');
  run(
    `INSERT INTO subscribers (id, name, kind, api_key_hash, api_key_hint, is_admin) VALUES (?,?,?,?,?,?)`,
    id, name, kind, hashKey(apiKey), apiKey.slice(-4), isAdmin ? 1 : 0,
  );
  // The only moment the plaintext key exists. Show it once, then it is gone.
  return { subscriber: get('SELECT * FROM subscribers WHERE id = ?', id), apiKey };
}

export function subscriberForKey(key) {
  if (!key) return null;
  return get('SELECT * FROM subscribers WHERE api_key_hash = ?', hashKey(key)) ?? null;
}

export function bearerFrom(request) {
  const header = request.headers.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return request.headers['x-api-key'] ?? null;
}

/**
 * The key in ADMIN_API_KEY must map to a REAL subscriber row, not a synthetic
 * object. Subscriptions, rules and feedback all carry a foreign key to
 * `subscribers`, so a caller that exists only in memory cannot create
 * anything — it fails at the database with "FOREIGN KEY constraint failed".
 *
 * So we materialise it on first use, and adopt it if the database already has
 * an admin under a different key.
 */
export function ensureEnvAdmin() {
  if (!config.adminApiKey) return null;

  const existing = subscriberForKey(config.adminApiKey);
  if (existing) return existing;

  const orphanedAdmin = get('SELECT * FROM subscribers WHERE is_admin = 1 ORDER BY created_at LIMIT 1');
  if (orphanedAdmin) {
    // The .env key changed since this database was created — repoint the
    // existing curator at the new key rather than growing a second admin.
    run(
      'UPDATE subscribers SET api_key_hash = ?, api_key_hint = ? WHERE id = ?',
      hashKey(config.adminApiKey), config.adminApiKey.slice(-4), orphanedAdmin.id,
    );
    return get('SELECT * FROM subscribers WHERE id = ?', orphanedAdmin.id);
  }

  return createSubscriber({
    name: 'Curator',
    kind: 'human',
    isAdmin: true,
    key: config.adminApiKey,
  }).subscriber;
}

/** Resolves the caller, or null. */
export function authenticate(request) {
  const key = bearerFrom(request);
  if (!key) return null;

  const subscriber = subscriberForKey(key);
  if (subscriber) return subscriber;

  // Only reachable the very first time the .env admin key is used.
  if (config.adminApiKey && safeEqual(key, config.adminApiKey)) return ensureEnvAdmin();
  return null;
}
