import { all, get, run, parseJson } from '../../db.js';
import { newId } from '../../lib/id.js';
import { badRequest, notFound } from '../router.js';
import { eventPayload } from '../../match/matcher.js';
import { CATEGORIES } from '../../ingest/taxonomy.js';

/**
 * ============================================================================
 * THE CURATION QUEUE — where a human improves the machine
 * ============================================================================
 * Matches routed to `pending` land here. A curator can:
 *
 *   approve          — send it, as is
 *   approve + edit   — fix the headline, category or severity, then send
 *   reject           — do not send, and say why
 *   reject + rule    — do not send, and never send anything like it again
 *
 * The last one is the important one. It is what turns an afternoon of
 * clicking into a system that needs less clicking tomorrow.
 * ============================================================================
 */
export function register(router) {
  router.get('/v1/curation/queue', ({ query }) => {
    const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
    const rows = all(
      `SELECT m.* FROM matches m WHERE m.status = 'pending'
        ${query.subscription_id ? 'AND m.subscription_id = ?' : ''}
        ORDER BY m.score DESC, m.created_at DESC LIMIT ?`,
      ...(query.subscription_id ? [query.subscription_id] : []), limit,
    );

    return {
      pending: rows.length,
      items: rows.map((match) => {
        const event = get('SELECT * FROM events WHERE id = ?', match.event_id);
        const subscription = get('SELECT * FROM subscriptions WHERE id = ?', match.subscription_id);
        const source = get('SELECT name, adapter, trust FROM sources WHERE id = ?', event.source_id);
        return {
          match_id: match.id,
          score: match.score,
          base_score: match.base_score,
          created_at: match.created_at,
          // Every reason the matcher had, in order. This is what a curator
          // reads instead of guessing.
          explain: parseJson(match.explain, []),
          subscription: { id: subscription?.id, name: subscription?.name, review_mode: subscription?.review_mode },
          source: source ?? null,
          event: eventPayload(event, null),
        };
      }),
    };
  });

  router.post('/v1/curation/matches/:id/approve', ({ params, body, caller }) => {
    const match = get('SELECT * FROM matches WHERE id = ?', params.id);
    if (!match) throw notFound('Match');
    if (match.status !== 'pending') throw badRequest(`This match is already "${match.status}"`);

    // Optional curator edits, applied to the delivered payload only — the
    // original event stays untouched so we never lose the source of truth.
    const override = {};
    if (body?.title) override.title = String(body.title).slice(0, 500);
    if (body?.summary) override.summary = String(body.summary).slice(0, 2000);
    if (body?.note) override.note = String(body.note).slice(0, 500);
    if (body?.category) {
      if (!CATEGORIES.includes(body.category)) throw badRequest(`Unknown category "${body.category}"`);
      override.category = body.category;
    }
    if (body?.severity !== undefined) {
      const severity = Number(body.severity);
      if (!Number.isInteger(severity) || severity < 1 || severity > 5) {
        throw badRequest('`severity` must be an integer from 1 to 5');
      }
      override.severity = severity;
    }

    run(
      `UPDATE matches SET status='approved', decided_by=?, decided_at=datetime('now'), override=? WHERE id=?`,
      caller.id, Object.keys(override).length ? JSON.stringify(override) : null, match.id,
    );
    run(
      'INSERT INTO feedback (id, match_id, event_id, actor, verdict, reason) VALUES (?,?,?,?,?,?)',
      newId('fbk'), match.id, match.event_id, caller.id, 'useful',
      Object.keys(override).length ? `approved with edits: ${Object.keys(override).join(', ')}` : 'approved as-is',
    );

    return { match_id: match.id, status: 'approved', override, edited: Object.keys(override) };
  });

  router.post('/v1/curation/matches/:id/reject', ({ params, body, caller }) => {
    const match = get('SELECT * FROM matches WHERE id = ?', params.id);
    if (!match) throw notFound('Match');
    if (match.status !== 'pending') throw badRequest(`This match is already "${match.status}"`);

    run(
      `UPDATE matches SET status='rejected', decided_by=?, decided_at=datetime('now') WHERE id=?`,
      caller.id, match.id,
    );
    run(
      'INSERT INTO feedback (id, match_id, event_id, actor, verdict, reason) VALUES (?,?,?,?,?,?)',
      newId('fbk'), match.id, match.event_id, caller.id,
      body?.verdict && body.verdict !== 'not_useful' ? body.verdict : 'not_useful',
      body?.reason ?? null,
    );

    // "Never again": the rejection becomes a standing rule.
    let createdRule = null;
    if (body?.rule) {
      const { kind = 'suppress', target, value, weight = 0.25, scope = 'subscription' } = body.rule;
      if (!['boost', 'suppress', 'block', 'require'].includes(kind)) {
        throw badRequest('`rule.kind` must be one of: boost, suppress, block, require');
      }
      if (!['keyword', 'source', 'category', 'domain', 'place', 'country'].includes(target)) {
        throw badRequest('`rule.target` must be one of: keyword, source, category, domain, place, country');
      }
      if (!value) throw badRequest('`rule.value` is required');

      const ruleId = newId('rul');
      run(
        `INSERT INTO rules (id, subscription_id, kind, target, value, weight, note, created_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        ruleId,
        scope === 'global' ? null : match.subscription_id,
        kind, target, String(value), Number(weight),
        body.reason ?? `Created from a rejection on ${new Date().toISOString().slice(0, 10)}`,
        caller.id,
      );
      createdRule = get('SELECT * FROM rules WHERE id = ?', ruleId);
    }

    return { match_id: match.id, status: 'rejected', rule: createdRule };
  });

  /** Approve or reject many at once — the queue is unusable without it. */
  router.post('/v1/curation/bulk', ({ body, caller }) => {
    const ids = Array.isArray(body?.match_ids) ? body.match_ids : [];
    const action = body?.action;
    if (!ids.length) throw badRequest('`match_ids` must be a non-empty array');
    if (!['approve', 'reject'].includes(action)) throw badRequest('`action` must be "approve" or "reject"');

    const status = action === 'approve' ? 'approved' : 'rejected';
    const verdict = action === 'approve' ? 'useful' : 'not_useful';
    let changed = 0;

    for (const id of ids) {
      const match = get('SELECT * FROM matches WHERE id = ? AND status = ?', id, 'pending');
      if (!match) continue;
      run(`UPDATE matches SET status=?, decided_by=?, decided_at=datetime('now') WHERE id=?`, status, caller.id, id);
      run('INSERT INTO feedback (id, match_id, event_id, actor, verdict, reason) VALUES (?,?,?,?,?,?)',
        newId('fbk'), id, match.event_id, caller.id, verdict, body.reason ?? `bulk ${action}`);
      changed += 1;
    }
    return { action, requested: ids.length, changed };
  });

  /** Recent decisions — an audit trail, and a sanity check on your curators. */
  router.get('/v1/curation/history', ({ query }) => {
    const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
    return {
      decisions: all(
        `SELECT f.*, e.title, e.category, e.severity, m.score
           FROM feedback f
           LEFT JOIN events e ON e.id = f.event_id
           LEFT JOIN matches m ON m.id = f.match_id
          ORDER BY f.created_at DESC LIMIT ?`,
        limit,
      ),
    };
  });
}
