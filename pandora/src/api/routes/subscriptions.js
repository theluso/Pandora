import { all, get, run, parseJson } from '../../db.js';
import { newId } from '../../lib/id.js';
import { badRequest, notFound, forbidden } from '../router.js';
import { CATEGORIES } from '../../ingest/taxonomy.js';
import { scoreMatch } from '../../match/engine.js';
import { backfillSubscription } from '../../match/matcher.js';

/** Validate a subscription filter and return it cleaned, or throw a useful error. */
export function validateFilter(filter) {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw badRequest('`filter` must be an object');
  }
  const clean = {};
  const stringList = (key) => {
    if (filter[key] === undefined) return;
    if (!Array.isArray(filter[key]) || filter[key].some((v) => typeof v !== 'string')) {
      throw badRequest(`\`filter.${key}\` must be an array of strings`);
    }
    clean[key] = filter[key].filter(Boolean);
  };

  stringList('keywordsAny');
  stringList('keywordsAll');
  stringList('keywordsNone');
  stringList('places');
  stringList('countries');
  stringList('sources');

  if (filter.categories !== undefined) {
    if (!Array.isArray(filter.categories)) throw badRequest('`filter.categories` must be an array');
    const unknown = filter.categories.filter((c) => !CATEGORIES.includes(c));
    if (unknown.length) {
      throw badRequest(`Unknown categories: ${unknown.join(', ')}`, { known: CATEGORIES });
    }
    clean.categories = filter.categories;
  }

  if (filter.minSeverity !== undefined) {
    const value = Number(filter.minSeverity);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw badRequest('`filter.minSeverity` must be an integer from 1 to 5');
    }
    clean.minSeverity = value;
  }

  if (filter.minConfidence !== undefined) {
    const value = Number(filter.minConfidence);
    if (!(value >= 0 && value <= 1)) throw badRequest('`filter.minConfidence` must be between 0 and 1');
    clean.minConfidence = value;
  }

  if (filter.near !== undefined) {
    if (!Array.isArray(filter.near)) throw badRequest('`filter.near` must be an array of watch circles');
    clean.near = filter.near.map((watch, index) => {
      const lat = Number(watch?.lat);
      const lon = Number(watch?.lon);
      const radiusKm = Number(watch?.radiusKm ?? 200);
      if (!(lat >= -90 && lat <= 90)) throw badRequest(`\`filter.near[${index}].lat\` must be between -90 and 90`);
      if (!(lon >= -180 && lon <= 180)) throw badRequest(`\`filter.near[${index}].lon\` must be between -180 and 180`);
      if (!(radiusKm > 0 && radiusKm <= 20000)) throw badRequest(`\`filter.near[${index}].radiusKm\` must be between 0 and 20000`);
      return { lat, lon, radiusKm, label: String(watch.label ?? `point ${index + 1}`) };
    });
  }

  if (filter.geoStrict !== undefined) clean.geoStrict = Boolean(filter.geoStrict);
  if (filter.geoMatch !== undefined) {
    if (!['any', 'all'].includes(filter.geoMatch)) {
      throw badRequest('`filter.geoMatch` must be "any" (default) or "all"');
    }
    clean.geoMatch = filter.geoMatch;
  }
  return clean;
}

export function validateDelivery(delivery) {
  if (delivery === undefined) return { channels: [] };
  if (delivery === null || typeof delivery !== 'object') throw badRequest('`delivery` must be an object');
  const channels = delivery.channels ?? [];
  if (!Array.isArray(channels)) throw badRequest('`delivery.channels` must be an array');

  for (const channel of channels) {
    if (channel?.type !== 'webhook') throw badRequest('Only `webhook` channels are supported today');
    let url;
    try {
      url = new URL(channel.url);
    } catch {
      throw badRequest('`delivery.channels[].url` must be a valid absolute URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw badRequest('Webhook URLs must be http or https');
    }
  }
  return { channels };
}

export function serialize(subscription) {
  return {
    id: subscription.id,
    name: subscription.name,
    filter: parseJson(subscription.filter, {}),
    delivery: parseJson(subscription.delivery, {}),
    review_mode: subscription.review_mode,
    threshold: subscription.threshold,
    active: Boolean(subscription.active),
    created_at: subscription.created_at,
    updated_at: subscription.updated_at,
  };
}

function ownedOrThrow(id, caller) {
  const subscription = get('SELECT * FROM subscriptions WHERE id = ?', id);
  if (!subscription) throw notFound('Subscription');
  if (!caller.is_admin && subscription.subscriber_id !== caller.id) throw forbidden();
  return subscription;
}

export function register(router) {
  router.get('/v1/subscriptions', ({ caller }) => {
    const rows = caller.is_admin
      ? all('SELECT * FROM subscriptions ORDER BY created_at DESC')
      : all('SELECT * FROM subscriptions WHERE subscriber_id = ? ORDER BY created_at DESC', caller.id);
    return { subscriptions: rows.map(serialize) };
  });

  router.post('/v1/subscriptions', ({ body, caller }) => {
    if (!body?.name) throw badRequest('`name` is required');
    const reviewMode = body.review_mode ?? 'auto';
    if (!['auto', 'review', 'hybrid'].includes(reviewMode)) {
      throw badRequest('`review_mode` must be one of: auto, review, hybrid');
    }
    const threshold = body.threshold === undefined ? 0.45 : Number(body.threshold);
    if (!(threshold >= 0 && threshold <= 1)) throw badRequest('`threshold` must be between 0 and 1');

    const filter = validateFilter(body.filter ?? {});
    const delivery = validateDelivery(body.delivery);
    const id = newId('sbn');

    run(
      `INSERT INTO subscriptions (id, subscriber_id, name, filter, delivery, review_mode, threshold)
       VALUES (?,?,?,?,?,?,?)`,
      id, caller.id, String(body.name).slice(0, 200),
      JSON.stringify(filter), JSON.stringify(delivery), reviewMode, threshold,
    );
    const subscription = get('SELECT * FROM subscriptions WHERE id = ?', id);

    // Populate the feed from recent history so the first poll is not empty.
    // `backfill_hours: 0` opts out.
    const backfill = backfillSubscription(subscription, {
      hours: body.backfill_hours === undefined ? 24 : Number(body.backfill_hours),
    });

    return { subscription: serialize(subscription), backfill };
  }, { status: 201 });

  router.get('/v1/subscriptions/:id', ({ params, caller }) =>
    ({ subscription: serialize(ownedOrThrow(params.id, caller)) }));

  router.patch('/v1/subscriptions/:id', ({ params, body, caller }) => {
    const existing = ownedOrThrow(params.id, caller);
    const updates = [];
    const values = [];

    if (body.name !== undefined) { updates.push('name = ?'); values.push(String(body.name).slice(0, 200)); }
    if (body.filter !== undefined) { updates.push('filter = ?'); values.push(JSON.stringify(validateFilter(body.filter))); }
    if (body.delivery !== undefined) { updates.push('delivery = ?'); values.push(JSON.stringify(validateDelivery(body.delivery))); }
    if (body.review_mode !== undefined) {
      if (!['auto', 'review', 'hybrid'].includes(body.review_mode)) {
        throw badRequest('`review_mode` must be one of: auto, review, hybrid');
      }
      updates.push('review_mode = ?'); values.push(body.review_mode);
    }
    if (body.threshold !== undefined) {
      const threshold = Number(body.threshold);
      if (!(threshold >= 0 && threshold <= 1)) throw badRequest('`threshold` must be between 0 and 1');
      updates.push('threshold = ?'); values.push(threshold);
    }
    if (body.active !== undefined) { updates.push('active = ?'); values.push(body.active ? 1 : 0); }
    if (!updates.length) throw badRequest('Nothing to update');

    updates.push(`updated_at = datetime('now')`);
    run(`UPDATE subscriptions SET ${updates.join(', ')} WHERE id = ?`, ...values, existing.id);
    const updated = get('SELECT * FROM subscriptions WHERE id = ?', existing.id);

    // A widened filter should pick up what it now covers, not only what
    // happens next. Already-judged events are skipped by matchEvent.
    const backfill = body.filter !== undefined
      ? backfillSubscription(updated, { hours: Number(body.backfill_hours ?? 24) })
      : undefined;

    return { subscription: serialize(updated), backfill };
  });

  router.delete('/v1/subscriptions/:id', ({ params, caller }) => {
    const existing = ownedOrThrow(params.id, caller);
    run('DELETE FROM subscriptions WHERE id = ?', existing.id);
    return { deleted: existing.id };
  });

  /**
   * Dry run. Score a filter against events already in the database WITHOUT
   * creating matches or delivering anything.
   *
   * This is the feature that makes the product usable by a non-engineer: you
   * can tune a subscription against real history, see exactly what it would
   * have sent you and why, and only then switch it on.
   */
  router.post('/v1/subscriptions/:id/test', ({ params, body, caller }) => {
    const existing = ownedOrThrow(params.id, caller);
    const candidate = {
      ...existing,
      filter: body?.filter ? JSON.stringify(validateFilter(body.filter)) : existing.filter,
      threshold: body?.threshold !== undefined ? Number(body.threshold) : existing.threshold,
    };

    const limit = Math.min(Number(body?.limit ?? 200), 1000);
    const events = all('SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?', limit);
    const sources = new Map(all('SELECT * FROM sources').map((s) => [s.id, s]));

    const scored = events.map((event) => {
      const result = scoreMatch(event, candidate, sources.get(event.source_id));
      return {
        event: { id: event.id, title: event.title, category: event.category, severity: event.severity, place: event.place_name, occurred_at: event.occurred_at },
        would_match: result.relevant,
        score: Number(result.score.toFixed(3)),
        explain: result.explain,
      };
    });

    const matched = scored.filter((s) => s.would_match).sort((a, b) => b.score - a.score);
    return {
      tested_against: events.length,
      would_match: matched.length,
      match_rate: events.length ? Number((matched.length / events.length).toFixed(3)) : 0,
      matches: matched,
      rejected_sample: scored.filter((s) => !s.would_match).slice(0, 10),
    };
  });
}
