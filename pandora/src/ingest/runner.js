import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, ROOT } from '../config.js';
import { all, get, run, parseJson } from '../db.js';
import { newId } from '../lib/id.js';
import { fetchText } from '../lib/http.js';
import { logger } from '../lib/log.js';
import { getAdapter } from './registry.js';
import { titleSimilarity, DUPLICATE_SIMILARITY } from './normalize.js';

const log = logger('ingest');

/**
 * Fetch a source's raw payload.
 *
 * In `fixture` mode we read a recorded sample from ./fixtures instead of
 * hitting the network. That is not a toy: it means the whole pipeline is
 * runnable and testable on a laptop with no internet, no API keys and no
 * rate limits — and the code path after this function is identical either way.
 */
export async function fetchPayload(adapter, source) {
  const sourceConfig = parseJson(source.config, {});

  if (config.ingestMode === 'fixture') {
    const fixtureName = sourceConfig.fixture ?? adapter.fixture;
    const path = resolve(ROOT, 'fixtures', fixtureName);
    if (!existsSync(path)) throw new Error(`No fixture at ${path}`);
    const text = readFileSync(path, 'utf8');
    return adapter.format === 'json' ? JSON.parse(text) : text;
  }

  const url = adapter.buildUrl(sourceConfig);
  const text = await fetchText(url, { timeoutMs: 25000 });
  return adapter.format === 'json' ? JSON.parse(text) : text;
}

/**
 * Store one normalised event, unless we have seen it before.
 * Returns the event row, plus whether it was new.
 */
export function storeEvent(candidate) {
  const existing = get('SELECT * FROM events WHERE dedupe_hash = ?', candidate.dedupe_hash);
  if (existing) return { event: existing, isNew: false, reason: 'exact-duplicate' };

  // Near-duplicate: same story, different outlet. Compare this headline's word
  // signature against the other stories already in its bucket; if one overlaps
  // enough, we keep the original and just count the corroboration. Five
  // reports of one strike is one event that five outlets agree on.
  const siblings = all(
    `SELECT c.id AS cluster_id, c.event_id, c.seen_count, e.title_tokens
       FROM event_clusters c JOIN events e ON e.id = c.event_id
      WHERE c.cluster_key = ? ORDER BY c.last_seen_at DESC LIMIT 25`,
    candidate.cluster_key,
  );

  for (const sibling of siblings) {
    const similarity = titleSimilarity(candidate.title_tokens, parseJson(sibling.title_tokens, []));
    if (similarity >= DUPLICATE_SIMILARITY) {
      run(
        `UPDATE event_clusters SET seen_count = seen_count + 1, last_seen_at = datetime('now') WHERE id = ?`,
        sibling.cluster_id,
      );
      const original = get('SELECT * FROM events WHERE id = ?', sibling.event_id);
      if (original) {
        return { event: original, isNew: false, reason: 'near-duplicate', similarity };
      }
    }
  }

  const id = newId('evt');
  run(
    `INSERT INTO events (id, source_id, external_id, dedupe_hash, title, summary, url,
       category, severity, confidence, occurred_at, expires_at, lat, lon, radius_km,
       place_name, country, entities, raw, cluster_key, title_tokens)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    candidate.source_id,
    candidate.external_id,
    candidate.dedupe_hash,
    candidate.title,
    candidate.summary,
    candidate.url,
    candidate.category,
    candidate.severity,
    candidate.confidence,
    candidate.occurred_at,
    candidate.expires_at,
    candidate.lat,
    candidate.lon,
    candidate.radius_km,
    candidate.place_name,
    candidate.country,
    JSON.stringify(candidate.entities ?? []),
    JSON.stringify(candidate.raw ?? {}),
    candidate.cluster_key,
    JSON.stringify(candidate.title_tokens ?? []),
  );

  run(
    `INSERT INTO event_clusters (id, cluster_key, event_id, seen_count, last_seen_at)
     VALUES (?,?,?,1,datetime('now'))`,
    newId('clu'), candidate.cluster_key, id,
  );

  return { event: get('SELECT * FROM events WHERE id = ?', id), isNew: true, reason: 'new' };
}

/** Poll one source end to end. Never throws — a broken feed must not stop the rest. */
export async function ingestSource(source) {
  const summary = { source: source.name, fetched: 0, stored: 0, duplicates: 0, error: null };

  try {
    const adapter = getAdapter(source.adapter);
    const payload = await fetchPayload(adapter, source);
    const candidates = adapter.parse(payload, {
      sourceId: source.id,
      config: parseJson(source.config, {}),
    });

    summary.fetched = candidates.length;
    summary.events = [];

    for (const candidate of candidates) {
      const { event, isNew } = storeEvent(candidate);
      if (isNew) {
        summary.stored += 1;
        summary.events.push(event);
      } else {
        summary.duplicates += 1;
      }
    }

    run(
      `UPDATE sources SET last_polled_at = datetime('now'), last_status = ?, last_error = NULL WHERE id = ?`,
      'ok',
      source.id,
    );
    log.info(`${source.name}: ${summary.stored} new, ${summary.duplicates} duplicate`);
  } catch (error) {
    summary.error = error.message;
    run(
      `UPDATE sources SET last_polled_at = datetime('now'), last_status = ?, last_error = ? WHERE id = ?`,
      'error',
      error.message,
      source.id,
    );
    log.error(`${source.name} failed: ${error.message}`);
  }

  return summary;
}

/** Poll every enabled source. Returns the new events for the matcher. */
export async function ingestAll({ force = false } = {}) {
  const sources = all('SELECT * FROM sources WHERE enabled = 1');
  const results = [];
  const newEvents = [];

  for (const source of sources) {
    if (!force && !isDue(source)) {
      log.debug(`${source.name}: not due yet, skipping`);
      continue;
    }
    const result = await ingestSource(source);
    results.push(result);
    newEvents.push(...(result.events ?? []));
  }

  return { results, newEvents };
}

export function isDue(source) {
  if (!source.last_polled_at) return true;
  const last = new Date(`${source.last_polled_at.replace(' ', 'T')}Z`).getTime();
  return Date.now() - last >= source.poll_seconds * 1000;
}
