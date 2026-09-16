import { sha1 } from '../lib/id.js';
import { findPlaces } from './gazetteer.js';
import {
  CATEGORY_SIGNALS, SEVERITY_SIGNALS, NOISE_SIGNALS, CATEGORIES,
  CATEGORY_SEVERITY_FLOOR, RECOVERY_SIGNALS, RECOVERY_CAP, matchesSignal,
} from './taxonomy.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Pick the single best category for a piece of text.
 * Scores every category by its signal phrases; the strongest wins. We also
 * return the runners-up so a curator can see it was a close call.
 */
export function classify(text) {
  const haystack = String(text || '');
  const scores = [];

  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    let total = 0;
    const matched = [];
    for (const [phrase, weight] of signals) {
      if (matchesSignal(haystack, phrase)) {
        total += weight;
        matched.push(phrase);
      }
    }
    if (total > 0) scores.push({ category, score: total, matched });
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (!best) return { category: 'other', confidence: 0.25, matched: [], alternatives: [] };

  // Confidence rises with absolute strength AND with the gap to second place.
  const runnerUp = scores[1]?.score ?? 0;
  const separation = best.score / (best.score + runnerUp);
  const confidence = clamp(0.3 + Math.min(best.score, 6) * 0.07 + separation * 0.25, 0.25, 0.95);

  return {
    category: best.category,
    confidence: Number(confidence.toFixed(2)),
    matched: best.matched,
    alternatives: scores.slice(1, 3).map((s) => s.category),
  };
}

/**
 * Severity on a 1–5 scale.
 * `floor` lets a structured source assert a minimum — a magnitude 7.1
 * earthquake is a 5 whatever the prose around it says.
 */
export function inferSeverity(text, { floor = 0, category = null } = {}) {
  const haystack = String(text || '');
  let severity = 0;
  const reasons = [];

  for (const [level, phrases] of SEVERITY_SIGNALS) {
    for (const phrase of phrases) {
      if (matchesSignal(haystack, phrase)) {
        if (level > severity) {
          severity = level;
          reasons.push(`"${phrase}" → ${level}`);
        }
        break;
      }
    }
  }
  if (severity === 0) severity = 2;

  // A category can insist on a minimum — calm wording must not hide a serious
  // event ("bulk carrier attacked by drone ... crew safe").
  const categoryFloor = category ? CATEGORY_SEVERITY_FLOOR[category] ?? 0 : 0;
  if (categoryFloor > severity) {
    severity = categoryFloor;
    reasons.push(`category "${category}" floor → ${categoryFloor}`);
  }

  // ...but a story about a disruption ENDING gets capped back down.
  const recovery = RECOVERY_SIGNALS.find((phrase) => matchesSignal(haystack, phrase));
  if (recovery && severity > RECOVERY_CAP) {
    severity = RECOVERY_CAP;
    reasons.push(`recovery language "${recovery}" caps severity at ${RECOVERY_CAP}`);
  }

  return { severity: clamp(Math.max(severity, floor), 1, 5), reasons };
}

/** Is this an operational signal, or trade-press filler? */
export function noiseScore(text) {
  const haystack = String(text || '');
  const hits = NOISE_SIGNALS.filter((phrase) => matchesSignal(haystack, phrase));
  return { isNoise: hits.length > 0, hits };
}

/** ISO-8601, or null. Accepts epoch millis, RFC-822 dates, and ISO strings. */
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The fingerprint that stops the same story being stored twice, even when
 * two sources word the headline slightly differently.
 */
export function dedupeHash({ sourceId, externalId, title, url }) {
  if (externalId) return sha1(`${sourceId}:${externalId}`);
  if (url) return sha1(`url:${String(url).split('?')[0]}`);
  return sha1(`title:${normaliseTitle(title)}`);
}

export function normaliseTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an|of|at|in|on|for|to|and|as|is|are|says|after|amid|its|by|with|from|over|into)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Crude stemming: "begins", "beginning" and "begin" must collapse to the same
 * token, or two outlets describing one strike look like two strikes. This is
 * not linguistics — it only has to be consistent.
 */
export function stemWord(word) {
  if (word.length <= 4) return word;
  return word.replace(/(ings|ing|ers|er|ies|ied|ed|es|s)$/, '');
}

/**
 * The coarse bucket a story falls into: what kind of thing, roughly where,
 * roughly when. Two events in different buckets are never duplicates, so this
 * is purely a cheap way to avoid comparing everything against everything.
 */
export function clusterKey({ category, places, occurredAt }) {
  const anchor = places?.[0]?.name?.toLowerCase() ?? 'global';
  const day = (occurredAt || new Date().toISOString()).slice(0, 10);
  return `${category}|${anchor}|${day}`;
}

/** The stemmed, de-stopworded word set of a headline. */
export function titleTokens(title) {
  return [...new Set(
    normaliseTitle(title).split(' ').filter((word) => word.length > 3).map(stemWord),
  )];
}

/**
 * Jaccard similarity: shared words ÷ total distinct words. 1.0 is identical,
 * 0 is nothing in common.
 *
 *   "Rotterdam dockworkers begin strike action at container terminals"
 *   "Strike action begins as Rotterdam dockworkers walk out of terminals"
 *   → 6 shared of 8 distinct = 0.75, comfortably one story.
 */
export function titleSimilarity(tokensA, tokensB) {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Above this, two headlines in the same bucket are treated as one event. */
export const DUPLICATE_SIMILARITY = 0.5;

/**
 * Build a canonical event from whatever an adapter managed to extract.
 * Every adapter ends here, which is why agents only ever learn one shape.
 */
export function buildEvent(input) {
  const {
    sourceId,
    externalId = null,
    title,
    summary = '',
    url = null,
    occurredAt,
    expiresAt = null,
    lat = null,
    lon = null,
    radiusKm = null,
    placeName = null,
    country = null,
    category: categoryHint = null,
    severity: severityHint = null,
    severityFloor = 0,
    confidence: confidenceHint = null,
    raw = {},
  } = input;

  const text = `${title} ${summary}`;
  const classified = categoryHint
    ? { category: categoryHint, confidence: confidenceHint ?? 0.9, matched: ['source-declared'], alternatives: [] }
    : classify(text);

  const severity = severityHint
    ? { severity: clamp(severityHint, 1, 5), reasons: ['source-declared'] }
    : inferSeverity(text, { floor: severityFloor, category: classified.category });

  const places = findPlaces(text);

  /**
   * Which place is THE place? A story headlined "Antwerp berth delays" whose
   * body mentions vessels diverted from Rotterdam must be located at Antwerp.
   * So we prefer, in order: a place named in the title, then a port, then
   * whatever we found. Gazetteer hit order is arbitrary and must never decide
   * this — that is how an Antwerp event ends up filed under Rotterdam.
   */
  const inTitle = new Set(findPlaces(title).map((p) => p.name));
  const anchor =
    places.find((p) => inTitle.has(p.name) && p.kind === 'port')
    ?? places.find((p) => inTitle.has(p.name))
    ?? places.find((p) => p.kind === 'port')
    ?? places[0]
    ?? null;

  const resolvedLat = Number.isFinite(lat) ? lat : anchor?.lat ?? null;
  const resolvedLon = Number.isFinite(lon) ? lon : anchor?.lon ?? null;
  const resolvedRadius = Number.isFinite(radiusKm) ? radiusKm : anchor?.radiusKm ?? null;

  const noise = noiseScore(text);
  const occurred = toIso(occurredAt) ?? new Date().toISOString();

  return {
    source_id: sourceId,
    external_id: externalId,
    dedupe_hash: dedupeHash({ sourceId, externalId, title, url }),
    cluster_key: clusterKey({ category: classified.category, places, occurredAt: occurred }),
    title_tokens: titleTokens(title),
    title: String(title).slice(0, 500),
    summary: String(summary).slice(0, 2000),
    url,
    category: CATEGORIES.includes(classified.category) ? classified.category : 'other',
    severity: severity.severity,
    confidence: noise.isNoise
      ? Number(Math.max(0.1, classified.confidence - 0.3).toFixed(2))
      : classified.confidence,
    occurred_at: occurred,
    expires_at: toIso(expiresAt),
    lat: resolvedLat,
    lon: resolvedLon,
    radius_km: resolvedRadius,
    place_name: placeName ?? anchor?.name ?? null,
    country: country ?? anchor?.country ?? null,
    entities: places.map((p) => ({ name: p.name, kind: p.kind, country: p.country, lat: p.lat, lon: p.lon })),
    raw,
    _diagnostics: {
      categoryMatched: classified.matched,
      categoryAlternatives: classified.alternatives,
      severityReasons: severity.reasons,
      noise: noise.hits,
    },
  };
}
