import { circlesOverlap } from '../lib/geo.js';
import { parseJson } from '../db.js';

/**
 * ============================================================================
 * THE MATCHER
 * ============================================================================
 * Given one event and one subscription, answer two questions:
 *   1. Is this relevant at all?  (hard gates — yes/no, no argument)
 *   2. How relevant?             (a 0–1 score built from weighted dimensions)
 *
 * Every number it produces carries a plain-English reason. A curator must be
 * able to look at a match and see *why* in two seconds, and a customer must be
 * able to ask "why did you send me this?" and get a real answer. A scoring
 * system nobody can interrogate is a scoring system nobody will trust.
 * ============================================================================
 */

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** Weights per dimension. Only the dimensions in play are counted, then
 *  normalised — so a subscription that says nothing about geography is not
 *  penalised for it. */
const WEIGHTS = {
  severity: 0.25,
  quality: 0.15,
  geo: 0.25,
  keywords: 0.20,
  category: 0.15,
};

export function textOf(event) {
  return `${event.title} ${event.summary ?? ''}`.toLowerCase();
}

/**
 * HARD GATES — any failure means "not relevant", no score computed.
 * These express the things a subscriber is certain about.
 */
export function checkGates(event, filter, source) {
  const text = textOf(event);
  const gates = [];

  if (filter.keywordsNone?.length) {
    const hit = filter.keywordsNone.find((word) => text.includes(word.toLowerCase()));
    if (hit) return { passed: false, reason: `excluded by keyword "${hit}"`, gates };
    gates.push('no excluded keywords present');
  }

  if (filter.keywordsAll?.length) {
    const missing = filter.keywordsAll.filter((word) => !text.includes(word.toLowerCase()));
    if (missing.length) {
      return { passed: false, reason: `missing required keyword(s): ${missing.join(', ')}`, gates };
    }
    gates.push(`all required keywords present (${filter.keywordsAll.join(', ')})`);
  }

  if (filter.categories?.length && !filter.categories.includes(event.category)) {
    return { passed: false, reason: `category "${event.category}" not watched`, gates };
  }

  const minSeverity = filter.minSeverity ?? 1;
  if (event.severity < minSeverity) {
    return { passed: false, reason: `severity ${event.severity} below minimum ${minSeverity}`, gates };
  }
  gates.push(`severity ${event.severity} ≥ minimum ${minSeverity}`);

  if (filter.minConfidence && event.confidence < filter.minConfidence) {
    return { passed: false, reason: `confidence ${event.confidence} below minimum ${filter.minConfidence}`, gates };
  }

  if (filter.sources?.length && source && !filter.sources.includes(source.id) && !filter.sources.includes(source.adapter)) {
    return { passed: false, reason: `source "${source.name}" not watched`, gates };
  }

  return { passed: true, reason: null, gates };
}

/**
 * GEOGRAPHY — the dimension that makes this more than a keyword alert.
 * Three ways to hit, strongest wins: a named place, a country, or a circle
 * on the map. `geoStrict` (default true) rejects events that are definitely
 * somewhere else; events with no known location get partial credit instead
 * of being thrown away.
 */
export function scoreGeo(event, filter) {
  const watchesGeo = filter.places?.length || filter.countries?.length || filter.near?.length;
  if (!watchesGeo) return null;

  const entities = parseJson(event.entities, []);
  const entityNames = entities.map((e) => String(e.name).toLowerCase());
  const constraints = [];

  if (filter.places?.length) {
    const hit = filter.places.find((place) => {
      const needle = place.toLowerCase();
      return entityNames.includes(needle) || String(event.place_name ?? '').toLowerCase().includes(needle);
    });
    constraints.push(hit
      ? { kind: 'place', satisfied: true, score: 1, detail: `names a watched place: ${hit}` }
      : { kind: 'place', satisfied: false, score: 0, detail: 'names none of the watched places' });
  }

  if (filter.countries?.length) {
    const wanted = filter.countries.map((c) => c.toUpperCase());
    const hit = event.country && wanted.includes(String(event.country).toUpperCase());
    constraints.push(hit
      ? { kind: 'country', satisfied: true, score: 0.8, detail: `in a watched country: ${event.country}` }
      : { kind: 'country', satisfied: false, score: 0, detail: `country ${event.country ?? 'unknown'} is not watched` });
  }

  if (filter.near?.length) {
    let best = null;
    for (const watch of filter.near) {
      const overlap = circlesOverlap(event, watch);
      if (!overlap?.overlaps) continue;
      // Dead centre scores 1.0, just-touching scores 0.35.
      const closeness = clamp01(1 - overlap.distanceKm / Math.max(overlap.reachKm, 1));
      const score = 0.35 + closeness * 0.65;
      if (!best || score > best.score) {
        best = {
          kind: 'near',
          satisfied: true,
          score,
          detail: `${Math.round(overlap.distanceKm)} km from ${watch.label ?? 'watched point'} (within ${Math.round(overlap.reachKm)} km)`,
        };
      }
    }
    constraints.push(best ?? { kind: 'near', satisfied: false, score: 0, detail: 'outside every watched radius' });
  }

  const located = Number.isFinite(event.lat) && Number.isFinite(event.lon);
  const strict = filter.geoStrict !== false;

  /**
   * `geoMatch` decides how multiple geographic constraints combine:
   *
   *   'any' (default) — "anywhere on this list". Rotterdam OR Antwerp OR
   *                      within 600 km of Hamburg. The usual intent.
   *   'all'           — every constraint must hold. Use it to intersect:
   *                      countries:['US'] + near:[Houston] means "in the US
   *                      AND near Houston", not "in the US, or near Houston".
   *
   * Getting this wrong is how a Los Angeles storm ends up in a Gulf Coast
   * customer's inbox, so the choice is explicit rather than guessed.
   */
  const mode = filter.geoMatch === 'all' ? 'all' : 'any';

  if (mode === 'all') {
    const failed = constraints.filter((c) => !c.satisfied);
    if (failed.length) {
      if (!located && failed.every((c) => c.kind === 'near')) {
        return { score: 0.3, detail: 'location unknown — passed through for review', hard: false };
      }
      return { score: 0, detail: `fails: ${failed.map((c) => c.detail).join('; ')}`, hard: strict };
    }
    const weakest = constraints.reduce((min, c) => (c.score < min.score ? c : min));
    return {
      score: weakest.score,
      detail: constraints.map((c) => c.detail).join('; '),
      hard: false,
    };
  }

  const satisfied = constraints.filter((c) => c.satisfied);
  if (satisfied.length) {
    const best = satisfied.reduce((max, c) => (c.score > max.score ? c : max));
    return { score: best.score, detail: best.detail, hard: false };
  }

  // Nothing matched. An event with no known location is uncertain rather than
  // irrelevant, so it gets partial credit and a look from a human.
  if (!located) return { score: 0.35, detail: 'location unknown — passed through for review', hard: false };
  return { score: 0, detail: 'outside every watched area', hard: strict };
}

/** KEYWORDS — the share of watched terms this event actually mentions. */
export function scoreKeywords(event, filter) {
  if (!filter.keywordsAny?.length) return null;
  const text = textOf(event);
  const hits = filter.keywordsAny.filter((word) => text.includes(word.toLowerCase()));
  if (!hits.length) return { score: 0, detail: 'mentions none of the watched terms', hard: false };
  // One strong hit already means a lot; more hits help but with diminishing returns.
  const score = clamp01(0.55 + (hits.length - 1) * 0.15);
  return { score, detail: `mentions ${hits.map((h) => `"${h}"`).join(', ')}`, hard: false };
}

export function scoreCategory(event, filter) {
  if (!filter.categories?.length) return null;
  return { score: 1, detail: `category "${event.category}" is watched`, hard: false };
}

export function scoreSeverity(event) {
  return {
    score: clamp01((event.severity - 1) / 4),
    detail: `severity ${event.severity}/5`,
    hard: false,
  };
}

export function scoreQuality(event, source) {
  const trust = source?.trust ?? 0.7;
  const score = clamp01(event.confidence * 0.6 + trust * 0.4);
  return {
    score,
    detail: `parse confidence ${event.confidence}, source trust ${trust}`,
    hard: false,
  };
}

/**
 * Score one event against one subscription.
 * Returns { relevant, score, explain[] } — never throws.
 */
export function scoreMatch(event, subscription, source) {
  const filter = parseJson(subscription.filter, {});
  const explain = [];

  const gate = checkGates(event, filter, source);
  if (!gate.passed) {
    return { relevant: false, score: 0, explain: [{ dimension: 'gate', passed: false, detail: gate.reason }] };
  }
  for (const detail of gate.gates) explain.push({ dimension: 'gate', passed: true, detail });

  const dimensions = {
    severity: scoreSeverity(event),
    quality: scoreQuality(event, source),
    geo: scoreGeo(event, filter),
    keywords: scoreKeywords(event, filter),
    category: scoreCategory(event, filter),
  };

  let weighted = 0;
  let totalWeight = 0;

  for (const [name, result] of Object.entries(dimensions)) {
    if (!result) continue; // dimension not expressed by this subscription
    if (result.hard) {
      return {
        relevant: false,
        score: 0,
        explain: [...explain, { dimension: name, passed: false, detail: result.detail }],
      };
    }
    const weight = WEIGHTS[name];
    weighted += result.score * weight;
    totalWeight += weight;
    explain.push({
      dimension: name,
      score: Number(result.score.toFixed(2)),
      weight,
      detail: result.detail,
    });
  }

  const score = totalWeight > 0 ? clamp01(weighted / totalWeight) : 0;
  const threshold = subscription.threshold ?? 0.45;

  explain.push({
    dimension: 'total',
    score: Number(score.toFixed(3)),
    detail: `${score >= threshold ? 'above' : 'below'} this subscription's threshold of ${threshold}`,
  });

  return { relevant: score >= threshold, score, explain };
}
