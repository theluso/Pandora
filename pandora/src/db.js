import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config, ROOT } from './config.js';

let handle = null;

export function db() {
  if (handle) return handle;
  mkdirSync(dirname(config.databasePath), { recursive: true });
  handle = new DatabaseSync(config.databasePath);
  handle.exec(readFileSync(resolve(ROOT, 'src/schema.sql'), 'utf8'));
  return handle;
}

/** Used by the test suite to run against a throwaway in-memory database. */
export function useMemoryDatabase() {
  handle = new DatabaseSync(':memory:');
  handle.exec(readFileSync(resolve(ROOT, 'src/schema.sql'), 'utf8'));
  return handle;
}

export function closeDatabase() {
  if (handle) {
    handle.close();
    handle = null;
  }
}

export const all = (sql, ...params) => db().prepare(sql).all(...params).map(row => ({ ...row }));
export const get = (sql, ...params) => {
  const row = db().prepare(sql).get(...params);
  return row ? { ...row } : undefined;
};
export const run = (sql, ...params) => db().prepare(sql).run(...params);

/** Wrap a function in a transaction — all of it lands, or none of it does. */
export function transaction(fn) {
  const handle = db();
  handle.exec('BEGIN');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (error) {
    handle.exec('ROLLBACK');
    throw error;
  }
}

/** SQLite has no JSON column type, so we parse on the way out. */
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
