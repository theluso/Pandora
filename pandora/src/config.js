import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader — avoids a dependency for a 20-line job. */
function loadDotEnv() {
  const path = resolve(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (/^(['"]).*\1$/s.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);

export const config = {
  port: num(process.env.PORT, 4180),
  host: process.env.HOST || '127.0.0.1',
  databasePath: resolve(ROOT, process.env.DATABASE_PATH || './data/pandora.db'),
  ingestMode: process.env.INGEST_MODE === 'live' ? 'live' : 'fixture',
  pollIntervalSeconds: num(process.env.POLL_INTERVAL_SECONDS, 300),
  webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET || 'change-me-in-production',
  adminApiKey: process.env.ADMIN_API_KEY || '',
  webhookTimeoutMs: num(process.env.WEBHOOK_TIMEOUT_MS, 10000),
  webhookMaxAttempts: num(process.env.WEBHOOK_MAX_ATTEMPTS, 5),
  ingestContact: process.env.INGEST_CONTACT || 'pandora@example.com',
  get userAgent() {
    return `pandora-events/0.1 (+${this.ingestContact})`;
  },
};
