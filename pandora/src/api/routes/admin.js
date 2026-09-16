import { all, get, run, parseJson } from '../../db.js';
import { newId } from '../../lib/id.js';
import { badRequest, notFound, forbidden } from '../router.js';
import { createSubscriber } from '../auth.js';
import { ADAPTERS, getAdapter } from '../../ingest/registry.js';
import { ingestAll, ingestSource } from '../../ingest/runner.js';
import { matchEvents } from '../../match/matcher.js';
import { flushDeliveries } from '../../delivery/dispatcher.js';

const adminOnly = (caller) => { if (!caller.is_admin) throw forbidden('Admin key required'); };

export function register(router) {
  // ── Sources ───────────────────────────────────────────────────────────
  router.get('/v1/sources', () => ({
    sources: all('SELECT * FROM sources ORDER BY name').map((s) => ({
      ...s, enabled: Boolean(s.enabled), config: parseJson(s.config, {}),
    })),
    available_adapters: Object.values(ADAPTERS).map((a) => ({
      id: a.id, label: a.label, format: a.format, default_config: a.defaultConfig,
    })),
  }));

  router.post('/v1/sources', ({ body, caller }) => {
    adminOnly(caller);
    if (!body?.name) throw badRequest('`name` is required');
    try {
      getAdapter(body.adapter);
    } catch (error) {
      throw badRequest(error.message);
    }
    const id = newId('src');
    run(
      `INSERT INTO sources (id, name, adapter, config, trust, poll_seconds, enabled)
       VALUES (?,?,?,?,?,?,?)`,
      id, String(body.name).slice(0, 200), body.adapter,
      JSON.stringify(body.config ?? {}),
      Number(body.trust ?? 0.8),
      Number(body.poll_seconds ?? 300),
      body.enabled === false ? 0 : 1,
    );
    return { source: get('SELECT * FROM sources WHERE id = ?', id) };
  }, { status: 201 });

  router.patch('/v1/sources/:id', ({ params, body, caller }) => {
    adminOnly(caller);
    const source = get('SELECT * FROM sources WHERE id = ?', params.id);
    if (!source) throw notFound('Source');
    const updates = [];
    const values = [];
    if (body.name !== undefined) { updates.push('name = ?'); values.push(String(body.name)); }
    if (body.config !== undefined) { updates.push('config = ?'); values.push(JSON.stringify(body.config)); }
    if (body.trust !== undefined) { updates.push('trust = ?'); values.push(Number(body.trust)); }
    if (body.poll_seconds !== undefined) { updates.push('poll_seconds = ?'); values.push(Number(body.poll_seconds)); }
    if (body.enabled !== undefined) { updates.push('enabled = ?'); values.push(body.enabled ? 1 : 0); }
    if (!updates.length) throw badRequest('Nothing to update');
    run(`UPDATE sources SET ${updates.join(', ')} WHERE id = ?`, ...values, source.id);
    return { source: get('SELECT * FROM sources WHERE id = ?', source.id) };
  });

  router.delete('/v1/sources/:id', ({ params, caller }) => {
    adminOnly(caller);
    if (!get('SELECT id FROM sources WHERE id = ?', params.id)) throw notFound('Source');
    run('DELETE FROM sources WHERE id = ?', params.id);
    return { deleted: params.id };
  });

  // ── Rules ─────────────────────────────────────────────────────────────
  router.get('/v1/rules', ({ query }) => ({
    rules: all(
      `SELECT r.*, s.name AS subscription_name FROM rules r
         LEFT JOIN subscriptions s ON s.id = r.subscription_id
        ${query.subscription_id ? 'WHERE r.subscription_id = ?' : ''}
        ORDER BY r.created_at DESC`,
      ...(query.subscription_id ? [query.subscription_id] : []),
    ).map((r) => ({ ...r, active: Boolean(r.active) })),
  }));

  router.post('/v1/rules', ({ body, caller }) => {
    const { kind, target, value, weight = 0.2, subscription_id = null, note = null } = body ?? {};
    if (!['boost', 'suppress', 'block', 'require'].includes(kind)) {
      throw badRequest('`kind` must be one of: boost, suppress, block, require');
    }
    if (!['keyword', 'source', 'category', 'domain', 'place', 'country'].includes(target)) {
      throw badRequest('`target` must be one of: keyword, source, category, domain, place, country');
    }
    if (!value) throw badRequest('`value` is required');
    if (subscription_id && !get('SELECT id FROM subscriptions WHERE id = ?', subscription_id)) {
      throw notFound('Subscription');
    }
    const id = newId('rul');
    run(
      `INSERT INTO rules (id, subscription_id, kind, target, value, weight, note, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, subscription_id, kind, target, String(value), Number(weight), note, caller.id,
    );
    return { rule: get('SELECT * FROM rules WHERE id = ?', id) };
  }, { status: 201 });

  router.patch('/v1/rules/:id', ({ params, body }) => {
    const rule = get('SELECT * FROM rules WHERE id = ?', params.id);
    if (!rule) throw notFound('Rule');
    const updates = [];
    const values = [];
    if (body.active !== undefined) { updates.push('active = ?'); values.push(body.active ? 1 : 0); }
    if (body.weight !== undefined) { updates.push('weight = ?'); values.push(Number(body.weight)); }
    if (body.note !== undefined) { updates.push('note = ?'); values.push(String(body.note)); }
    if (!updates.length) throw badRequest('Nothing to update');
    run(`UPDATE rules SET ${updates.join(', ')} WHERE id = ?`, ...values, rule.id);
    return { rule: get('SELECT * FROM rules WHERE id = ?', rule.id) };
  });

  router.delete('/v1/rules/:id', ({ params }) => {
    if (!get('SELECT id FROM rules WHERE id = ?', params.id)) throw notFound('Rule');
    run('DELETE FROM rules WHERE id = ?', params.id);
    return { deleted: params.id };
  });

  // ── Subscribers (minting API keys) ────────────────────────────────────
  router.get('/v1/admin/subscribers', ({ caller }) => {
    adminOnly(caller);
    return {
      subscribers: all(
        `SELECT s.id, s.name, s.kind, s.api_key_hint, s.is_admin, s.created_at,
                (SELECT COUNT(*) FROM subscriptions x WHERE x.subscriber_id = s.id) AS subscriptions
           FROM subscribers s ORDER BY s.created_at DESC`,
      ).map((s) => ({ ...s, is_admin: Boolean(s.is_admin) })),
    };
  });

  router.post('/v1/admin/subscribers', ({ body, caller }) => {
    adminOnly(caller);
    if (!body?.name) throw badRequest('`name` is required');
    const { subscriber, apiKey } = createSubscriber({
      name: String(body.name).slice(0, 200),
      kind: body.kind === 'human' ? 'human' : 'agent',
      isAdmin: Boolean(body.is_admin),
    });
    return {
      subscriber: { id: subscriber.id, name: subscriber.name, kind: subscriber.kind },
      // Shown exactly once — we only keep a hash.
      api_key: apiKey,
      warning: 'Copy this key now. It cannot be retrieved again.',
    };
  }, { status: 201 });

  // ── Pipeline control ──────────────────────────────────────────────────
  /** Run the whole pipeline on demand: poll → normalise → match → deliver. */
  router.post('/v1/admin/run', async ({ body, caller }) => {
    adminOnly(caller);
    const { results, newEvents } = body?.source_id
      ? await runOne(body.source_id)
      : await ingestAll({ force: body?.force !== false });

    const outcomes = matchEvents(newEvents);
    const deliveries = await flushDeliveries();

    return {
      sources: results,
      new_events: newEvents.length,
      matches_created: outcomes.filter((o) => o.matchId).length,
      queued_for_review: outcomes.filter((o) => o.status === 'pending').length,
      auto_approved: outcomes.filter((o) => o.status === 'approved').length,
      webhooks_attempted: deliveries.length,
      webhooks_succeeded: deliveries.filter((d) => d.ok).length,
    };
  });

  router.get('/v1/admin/stats', ({ caller }) => {
    adminOnly(caller);
    const one = (sql, ...args) => get(sql, ...args) ?? {};
    return {
      events: one('SELECT COUNT(*) AS total FROM events').total,
      events_by_category: all('SELECT category, COUNT(*) AS n FROM events GROUP BY category ORDER BY n DESC'),
      events_by_severity: all('SELECT severity, COUNT(*) AS n FROM events GROUP BY severity ORDER BY severity DESC'),
      matches: all('SELECT status, COUNT(*) AS n FROM matches GROUP BY status'),
      pending_review: one("SELECT COUNT(*) AS n FROM matches WHERE status='pending'").n,
      subscriptions: one('SELECT COUNT(*) AS n FROM subscriptions WHERE active=1').n,
      subscribers: one('SELECT COUNT(*) AS n FROM subscribers').n,
      rules: one('SELECT COUNT(*) AS n FROM rules WHERE active=1').n,
      deliveries: all('SELECT status, channel, COUNT(*) AS n FROM deliveries GROUP BY status, channel'),
      sources: all('SELECT name, last_status, last_polled_at, last_error FROM sources'),
      // Approval rate is the number to watch: if curators reject most of what
      // they see, the filters are wrong and the product is wasting their time.
      curation: one(
        `SELECT
            SUM(CASE WHEN verdict='useful' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN verdict!='useful' THEN 1 ELSE 0 END) AS rejected,
            COUNT(*) AS total
          FROM feedback`,
      ),
    };
  });

  router.get('/v1/admin/deliveries', ({ query, caller }) => {
    adminOnly(caller);
    const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
    return {
      deliveries: all(
        `SELECT d.*, e.title, s.name AS subscription_name
           FROM deliveries d
           JOIN matches m ON m.id = d.match_id
           JOIN events e ON e.id = m.event_id
           JOIN subscriptions s ON s.id = m.subscription_id
          ORDER BY d.created_at DESC LIMIT ?`,
        limit,
      ),
    };
  });
}

async function runOne(sourceId) {
  const source = get('SELECT * FROM sources WHERE id = ?', sourceId);
  if (!source) throw notFound('Source');
  const result = await ingestSource(source);
  return { results: [result], newEvents: result.events ?? [] };
}
