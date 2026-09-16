import { all, get, run, parseJson } from '../db.js';
import { newId } from '../lib/id.js';
import { logger } from '../lib/log.js';
import { scoreMatch } from './engine.js';
import { activeRulesFor, applyRules } from './rules.js';

const log = logger('match');

/**
 * Run one event past every active subscription and record what happens.
 *
 * The routing decision at the end is the product's core policy:
 *
 *   review_mode = 'auto'   → anything relevant goes straight out
 *   review_mode = 'review' → everything waits for a human
 *   review_mode = 'hybrid' → high-confidence matches go out, the rest wait
 *
 * Hybrid is the one most customers end up on: the obvious stuff is fast, the
 * marginal stuff gets a human, and the human's decisions become rules that
 * shrink the marginal pile over time.
 */
export function matchEvent(event, { subscriptions } = {}) {
  const source = get('SELECT * FROM sources WHERE id = ?', event.source_id);
  const targets = subscriptions ?? all('SELECT * FROM subscriptions WHERE active = 1');
  const outcomes = [];

  for (const subscription of targets) {
    const existing = get(
      'SELECT id FROM matches WHERE event_id = ? AND subscription_id = ?',
      event.id,
      subscription.id,
    );
    if (existing) continue; // already judged — never double-deliver

    const base = scoreMatch(event, subscription, source);
    if (!base.relevant && base.score === 0) {
      outcomes.push({ subscription, status: 'not_relevant', score: 0, explain: base.explain });
      continue;
    }

    const rules = activeRulesFor(subscription.id);
    const adjusted = applyRules(base.score, event, source, rules);

    const explain = [
      ...base.explain,
      ...adjusted.applied.map((entry) => ({
        dimension: 'rule',
        detail: entry.detail,
        delta: entry.delta,
      })),
    ];

    if (adjusted.blocked) {
      explain.push({ dimension: 'rule', passed: false, detail: adjusted.blocked.detail });
      record(event, subscription, adjusted.score, base.score, explain, 'suppressed', `rule:${adjusted.blocked.rule.id}`);
      outcomes.push({ subscription, status: 'suppressed', score: 0, explain });
      continue;
    }

    const threshold = subscription.threshold ?? 0.45;
    if (adjusted.score < threshold) {
      outcomes.push({ subscription, status: 'below_threshold', score: adjusted.score, explain });
      continue;
    }

    const routing = routeFor(subscription, adjusted.score, threshold, { event, source });
    explain.push({ dimension: 'routing', detail: routing.reason });

    const decidedBy = routing.status === 'approved' ? 'auto' : null;
    const matchId = record(event, subscription, adjusted.score, base.score, explain, routing.status, decidedBy);

    outcomes.push({ subscription, matchId, status: routing.status, score: adjusted.score, explain });
  }

  const routed = outcomes.filter((o) => o.matchId);
  if (routed.length) {
    log.info(`event ${event.id.slice(0, 12)} → ${routed.length} match(es)`, routed.map((o) => `${o.subscription.name}:${o.status}`));
  }
  return outcomes;
}

/**
 * Decide whether this match goes out now or waits for a human.
 *
 * The interesting mode is `hybrid`, and the rule there is NOT "low score goes
 * to review". A low score is already dropped below the threshold. What a human
 * should see is what the machine is UNSURE about:
 *
 *   · the parse was a guess           (low confidence — a bare headline)
 *   · the source is a wide net        (low trust — GDELT over curated feeds)
 *   · the score sits near the line    (a coin-flip either way)
 *
 * Everything else — high confidence, trusted source, comfortably over the
 * line — ships without waiting for anybody. That is what makes the queue
 * small enough that a person will actually work it.
 */
export function routeFor(subscription, score, threshold, { event, source } = {}) {
  switch (subscription.review_mode) {
    case 'review':
      return { status: 'pending', reason: 'subscription reviews everything' };

    case 'hybrid': {
      const confidence = event?.confidence ?? 1;
      const trust = source?.trust ?? 1;

      if (confidence < 0.6) {
        return { status: 'pending', reason: `parse confidence ${confidence} is low — needs a human eye` };
      }
      if (trust < 0.7) {
        return { status: 'pending', reason: `source trust ${trust} is low — wide-net feed, curate before sending` };
      }
      if (score - threshold < 0.15) {
        return { status: 'pending', reason: `score ${score.toFixed(2)} is close to the ${threshold} threshold` };
      }
      return { status: 'approved', reason: 'confident parse from a trusted source, comfortably over the threshold' };
    }

    case 'auto':
    default:
      return { status: 'approved', reason: 'subscription delivers everything relevant automatically' };
  }
}

function record(event, subscription, score, baseScore, explain, status, decidedBy) {
  const id = newId('mat');
  run(
    `INSERT INTO matches (id, event_id, subscription_id, score, base_score, explain, status, decided_by, decided_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    event.id,
    subscription.id,
    Number(score.toFixed(4)),
    Number(baseScore.toFixed(4)),
    JSON.stringify(explain),
    status,
    decidedBy,
    decidedBy ? new Date().toISOString() : null,
  );
  return id;
}

/** Convenience: match a batch of freshly ingested events. */
export function matchEvents(events) {
  const subscriptions = all('SELECT * FROM subscriptions WHERE active = 1');
  const all_outcomes = [];
  for (const event of events) {
    all_outcomes.push(...matchEvent(event, { subscriptions }));
  }
  return all_outcomes;
}

/**
 * Match a NEW subscription against events we already hold.
 *
 * Without this, a customer who signs up at 4pm sees an empty feed until the
 * next thing happens in the world — which for a narrow filter could be days.
 * They would reasonably conclude the product is broken.
 *
 * The window is deliberately short (a day by default): recent events are
 * still actionable, last month's port closure is history, and nobody wants
 * their first hour of service to be a thousand-item backlog.
 */
export function backfillSubscription(subscription, { hours = 24, limit = 500 } = {}) {
  if (!hours || hours <= 0) return { scanned: 0, matched: 0 };

  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const events = all(
    'SELECT * FROM events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?',
    since, limit,
  );

  let matched = 0;
  for (const event of events) {
    const outcomes = matchEvent(event, { subscriptions: [subscription] });
    matched += outcomes.filter((o) => o.matchId).length;
  }

  log.info(`backfill "${subscription.name}": ${matched} match(es) from ${events.length} recent events`);
  return { scanned: events.length, matched };
}

/** The payload an agent actually receives. One shape, forever. */
export function eventPayload(event, match) {
  const override = match?.override ? parseJson(match.override, {}) : {};
  return {
    id: event.id,
    title: override.title ?? event.title,
    summary: override.summary ?? event.summary,
    url: event.url,
    category: override.category ?? event.category,
    severity: override.severity ?? event.severity,
    confidence: event.confidence,
    occurred_at: event.occurred_at,
    ingested_at: event.ingested_at,
    expires_at: event.expires_at,
    location: Number.isFinite(event.lat)
      ? { lat: event.lat, lon: event.lon, radius_km: event.radius_km, place: event.place_name, country: event.country }
      : null,
    entities: parseJson(event.entities, []),
    source: { id: event.source_id },
    match: match
      ? {
          id: match.id,
          subscription_id: match.subscription_id,
          score: match.score,
          reviewed: match.decided_by !== 'auto' && match.decided_by !== null,
          curator_note: override.note ?? null,
          explain: parseJson(match.explain, []),
        }
      : null,
  };
}
