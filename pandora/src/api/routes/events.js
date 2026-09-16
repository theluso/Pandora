import { all, get, run, parseJson } from '../../db.js';
import { newId } from '../../lib/id.js';
import { badRequest, notFound } from '../router.js';
import { eventPayload } from '../../match/matcher.js';
import { CATEGORIES, SEVERITY } from '../../ingest/taxonomy.js';

/**
 * The agent-facing read API.
 *
 * `GET /v1/events` is the pull feed: everything approved for your
 * subscriptions, newest last, with a cursor. An agent stores the cursor,
 * polls on its own schedule, and can never miss or double-process an event.
 * This is the endpoint most integrations will actually live on.
 */
export function register(router) {
  router.get('/v1/events', ({ query, caller }) => {
    const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
    const conditions = ["m.status IN ('approved','delivered')"];
    const values = [];

    if (!caller.is_admin || query.mine === 'true') {
      conditions.push('s.subscriber_id = ?');
      values.push(caller.id);
    }
    if (query.subscription_id) {
      conditions.push('m.subscription_id = ?');
      values.push(query.subscription_id);
    }
    if (query.category) {
      conditions.push('e.category = ?');
      values.push(query.category);
    }
    if (query.min_severity) {
      conditions.push('e.severity >= ?');
      values.push(Number(query.min_severity));
    }
    // The cursor is the previous page's last match id. Ids are time-ordered,
    // so "greater than" means "newer than anything you have already seen".
    if (query.cursor) {
      conditions.push('m.id > ?');
      values.push(query.cursor);
    }
    if (query.since) {
      conditions.push('e.occurred_at >= ?');
      values.push(query.since);
    }

    const rows = all(
      `SELECT m.*, e.id AS e_id FROM matches m
         JOIN subscriptions s ON s.id = m.subscription_id
         JOIN events e ON e.id = m.event_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.id ASC LIMIT ?`,
      ...values, limit,
    );

    const events = rows.map((match) => {
      const event = get('SELECT * FROM events WHERE id = ?', match.event_id);
      return eventPayload(event, match);
    });

    return {
      events,
      count: events.length,
      // Pass this back as ?cursor= next time. Null means you are up to date.
      next_cursor: rows.length === limit ? rows[rows.length - 1].id : null,
      has_more: rows.length === limit,
    };
  });

  router.get('/v1/events/:id', ({ params, caller }) => {
    const event = get('SELECT * FROM events WHERE id = ?', params.id);
    if (!event) throw notFound('Event');
    const match = caller.is_admin
      ? get('SELECT * FROM matches WHERE event_id = ? ORDER BY score DESC LIMIT 1', event.id)
      : get(
          `SELECT m.* FROM matches m JOIN subscriptions s ON s.id = m.subscription_id
            WHERE m.event_id = ? AND s.subscriber_id = ? ORDER BY m.score DESC LIMIT 1`,
          event.id, caller.id,
        );
    if (!match && !caller.is_admin) throw notFound('Event');
    return { event: eventPayload(event, match), raw: caller.is_admin ? parseJson(event.raw, {}) : undefined };
  });

  /**
   * Feedback from the consuming agent — "this was useful", "wrong category".
   * Cheap to send, and it is the signal that tells a curator which
   * subscriptions are misfiring before the customer complains.
   */
  router.post('/v1/events/:id/feedback', ({ params, body, caller }) => {
    const event = get('SELECT * FROM events WHERE id = ?', params.id);
    if (!event) throw notFound('Event');

    const allowed = ['useful', 'not_useful', 'wrong_category', 'wrong_severity', 'duplicate'];
    if (!allowed.includes(body?.verdict)) {
      throw badRequest(`\`verdict\` must be one of: ${allowed.join(', ')}`);
    }

    const match = get(
      `SELECT m.* FROM matches m JOIN subscriptions s ON s.id = m.subscription_id
        WHERE m.event_id = ? AND s.subscriber_id = ? ORDER BY m.created_at DESC LIMIT 1`,
      event.id, caller.id,
    );

    const id = newId('fbk');
    run(
      'INSERT INTO feedback (id, match_id, event_id, actor, verdict, reason) VALUES (?,?,?,?,?,?)',
      id, match?.id ?? null, event.id, caller.id, body.verdict, body.reason ?? null,
    );
    return { feedback_id: id, recorded: true };
  });

  /** The vocabulary, so an agent can discover what it is allowed to ask for. */
  router.get('/v1/catalog', () => ({
    categories: CATEGORIES,
    severities: Object.entries(SEVERITY).map(([value, label]) => ({ value: Number(value), label })),
    sources: all('SELECT id, name, adapter, trust, enabled, last_status, last_polled_at FROM sources')
      .map((s) => ({ ...s, enabled: Boolean(s.enabled) })),
    review_modes: [
      { value: 'auto', description: 'Deliver every relevant match immediately' },
      { value: 'review', description: 'Hold every match for human approval' },
      { value: 'hybrid', description: 'Deliver high-scoring matches, hold the rest for review' },
    ],
  }));

  router.get('/v1/me', ({ caller }) => ({
    id: caller.id,
    name: caller.name,
    kind: caller.kind,
    is_admin: Boolean(caller.is_admin),
    subscriptions: all('SELECT COUNT(*) AS n FROM subscriptions WHERE subscriber_id = ?', caller.id)[0]?.n ?? 0,
  }));
}
