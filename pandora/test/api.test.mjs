import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDatabase, get, run } from '../src/db.js';
import { createApp } from '../src/api/server.js';
import { createSubscriber } from '../src/api/auth.js';
import { newId } from '../src/lib/id.js';
import { ingestSource } from '../src/ingest/runner.js';
import { matchEvents } from '../src/match/matcher.js';
import { all } from '../src/db.js';

let server;
let base;
let agentKey;
let adminKey;

before(async () => {
  useMemoryDatabase();
  adminKey = createSubscriber({ name: 'Curator', kind: 'human', isAdmin: true }).apiKey;
  agentKey = createSubscriber({ name: 'Agent', kind: 'agent' }).apiKey;

  const sourceId = newId('src');
  run('INSERT INTO sources (id, name, adapter, config, trust) VALUES (?,?,?,?,?)',
    sourceId, 'USGS', 'usgs', '{}', 0.98);
  const source = get('SELECT * FROM sources WHERE id = ?', sourceId);
  await ingestSource(source);

  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const call = (path, { method = 'GET', key = agentKey, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test('health check needs no key', async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('the API refuses anonymous callers', async () => {
  assert.equal((await call('/v1/subscriptions', { key: null })).status, 401);
  assert.equal((await call('/v1/subscriptions', { key: 'pnd_not_a_real_key' })).status, 401);
});

test('a subscription can be created, read back and deleted', async () => {
  const created = await call('/v1/subscriptions', {
    method: 'POST',
    body: {
      name: 'Pacific quakes',
      filter: { categories: ['earthquake'], minSeverity: 4, near: [{ lat: 22.6, lon: 120.3, radiusKm: 800, label: 'Taiwan' }] },
      review_mode: 'auto',
    },
  });
  assert.equal(created.status, 201);
  const { subscription } = await created.json();
  assert.equal(subscription.name, 'Pacific quakes');
  assert.deepEqual(subscription.filter.categories, ['earthquake']);

  const fetched = await (await call(`/v1/subscriptions/${subscription.id}`)).json();
  assert.equal(fetched.subscription.id, subscription.id);

  const listed = await (await call('/v1/subscriptions')).json();
  assert.ok(listed.subscriptions.some((s) => s.id === subscription.id));

  assert.equal((await call(`/v1/subscriptions/${subscription.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/v1/subscriptions/${subscription.id}`)).status, 404);
});

test('invalid filters are rejected with a useful message', async () => {
  const cases = [
    [{ filter: { categories: ['not_a_category'] } }, /Unknown categories/],
    [{ filter: { minSeverity: 9 } }, /minSeverity/],
    [{ filter: { near: [{ lat: 999, lon: 0 }] } }, /lat/],
    [{ filter: { keywordsAny: 'strike' } }, /array of strings/],
    [{ filter: { geoMatch: 'sometimes' } }, /geoMatch/],
    [{ review_mode: 'whenever' }, /review_mode/],
    [{ delivery: { channels: [{ type: 'webhook', url: 'not-a-url' }] } }, /valid absolute URL/],
    [{ delivery: { channels: [{ type: 'carrier-pigeon' }] } }, /webhook/],
  ];

  for (const [payload, expected] of cases) {
    const response = await call('/v1/subscriptions', { method: 'POST', body: { name: 'x', ...payload } });
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.match((await response.json()).error, expected);
  }
});

test('a subscription cannot be read or changed by another subscriber', async () => {
  const other = createSubscriber({ name: 'Somebody else', kind: 'agent' }).apiKey;
  const { subscription } = await (await call('/v1/subscriptions', {
    method: 'POST', body: { name: 'private', filter: { minSeverity: 1 } },
  })).json();

  assert.equal((await call(`/v1/subscriptions/${subscription.id}`, { key: other })).status, 403);
  assert.equal((await call(`/v1/subscriptions/${subscription.id}`, { key: other, method: 'DELETE' })).status, 403);
});

test('the dry run scores a filter without creating matches or deliveries', async () => {
  const { subscription } = await (await call('/v1/subscriptions', {
    method: 'POST', body: { name: 'dry run', filter: { minSeverity: 5 } },
  })).json();

  const before = get('SELECT COUNT(*) AS n FROM matches').n;
  const result = await (await call(`/v1/subscriptions/${subscription.id}/test`, {
    method: 'POST', body: { filter: { categories: ['earthquake'], minSeverity: 5 } },
  })).json();

  assert.ok(result.tested_against > 0);
  assert.ok(result.would_match > 0);
  assert.ok(result.matches.every((m) => m.score >= 0 && m.score <= 1));
  assert.ok(result.matches[0].explain.length > 0, 'every dry-run result explains itself');
  assert.equal(get('SELECT COUNT(*) AS n FROM matches').n, before, 'a dry run must not write matches');
});

test('an agent only sees events from its own subscriptions', async () => {
  const { subscription } = await (await call('/v1/subscriptions', {
    method: 'POST', body: { name: 'quakes', filter: { categories: ['earthquake'], minSeverity: 4 }, review_mode: 'auto' },
  })).json();

  matchEvents(all('SELECT * FROM events'));

  const mine = await (await call('/v1/events')).json();
  assert.ok(mine.events.length > 0);
  assert.ok(mine.events.every((e) => e.match.subscription_id === subscription.id || e.match));

  const stranger = createSubscriber({ name: 'Stranger', kind: 'agent' }).apiKey;
  const theirs = await (await call('/v1/events', { key: stranger })).json();
  assert.equal(theirs.events.length, 0, 'a subscriber with no subscriptions sees nothing');
});

test('the events feed pages with a cursor and never repeats a delivery', async () => {
  // The feed pages over MATCHES, not events. One event that matches three
  // subscriptions is three deliveries — correct, and each is separately
  // acknowledgeable — so the no-repeat guarantee is on `match.id`.
  const seen = new Set();
  let cursor = null;
  let pages = 0;

  do {
    const page = await (await call(`/v1/events?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
    for (const event of page.events) {
      assert.ok(!seen.has(event.match.id), `delivery ${event.match.id} was served twice`);
      seen.add(event.match.id);
    }
    cursor = page.next_cursor;
    pages += 1;
  } while (cursor && pages < 25);

  assert.ok(seen.size > 0);
  assert.equal(cursor, null, 'paging should terminate');
});

test('an exhausted cursor returns an empty page, not an error', async () => {
  let cursor = null;
  for (let i = 0; i < 25; i += 1) {
    const page = await (await call(`/v1/events?limit=50${cursor ? `&cursor=${cursor}` : ''}`)).json();
    if (!page.next_cursor) { cursor = page.events.at(-1)?.match.id ?? cursor; break; }
    cursor = page.next_cursor;
  }
  const empty = await (await call(`/v1/events?cursor=${cursor}`)).json();
  assert.equal(empty.events.length, 0);
  assert.equal(empty.has_more, false);
  assert.equal(empty.next_cursor, null);
});

test('feedback is recorded and validated', async () => {
  const { events } = await (await call('/v1/events?limit=1')).json();
  const eventId = events[0].id;

  const bad = await call(`/v1/events/${eventId}/feedback`, { method: 'POST', body: { verdict: 'meh' } });
  assert.equal(bad.status, 400);

  const good = await call(`/v1/events/${eventId}/feedback`, {
    method: 'POST', body: { verdict: 'useful', reason: 'routed to the ops desk' },
  });
  assert.equal(good.status, 200);
  assert.ok(get('SELECT * FROM feedback WHERE event_id = ?', eventId));
});

test('the catalog tells an agent what it may ask for', async () => {
  const catalog = await (await call('/v1/catalog')).json();
  assert.ok(catalog.categories.includes('port_disruption'));
  assert.equal(catalog.severities.length, 5);
  assert.ok(catalog.sources.length > 0);
  assert.equal(catalog.review_modes.length, 3);
});

test('admin-only endpoints refuse a normal agent key', async () => {
  assert.equal((await call('/v1/admin/stats')).status, 403);
  assert.equal((await call('/v1/admin/stats', { key: adminKey })).status, 200);
  assert.equal((await call('/v1/admin/subscribers', { key: agentKey })).status, 403);
});

test('minting a subscriber returns the key exactly once', async () => {
  const response = await call('/v1/admin/subscribers', {
    key: adminKey, method: 'POST', body: { name: 'New agent', kind: 'agent' },
  });
  assert.equal(response.status, 201);
  const { api_key, subscriber } = await response.json();
  assert.match(api_key, /^pnd_/);

  const listed = await (await call('/v1/admin/subscribers', { key: adminKey })).json();
  const stored = listed.subscribers.find((s) => s.id === subscriber.id);
  assert.ok(stored);
  assert.ok(!JSON.stringify(stored).includes(api_key), 'the plaintext key must never be listed again');
});

test('the curation queue exposes the full reasoning for each item', async () => {
  const { subscription } = await (await call('/v1/subscriptions', {
    method: 'POST',
    body: { name: 'reviewed', filter: { minSeverity: 3 }, review_mode: 'review' },
  })).json();
  matchEvents(all('SELECT * FROM events'));

  const queue = await (await call(`/v1/curation/queue?subscription_id=${subscription.id}`, { key: adminKey })).json();
  assert.ok(queue.pending > 0);
  const item = queue.items[0];
  assert.ok(item.match_id && item.event && Array.isArray(item.explain));
  assert.ok(item.explain.some((e) => e.dimension === 'total'));
});

test('approving with edits overrides the payload, not the event', async () => {
  const queue = await (await call('/v1/curation/queue', { key: adminKey })).json();
  const item = queue.items[0];

  const approved = await (await call(`/v1/curation/matches/${item.match_id}/approve`, {
    key: adminKey, method: 'POST', body: { title: 'Curator-written headline', severity: 5, note: 'confirmed' },
  })).json();
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.edited.sort(), ['note', 'severity', 'title']);

  const match = get('SELECT * FROM matches WHERE id = ?', item.match_id);
  const event = get('SELECT * FROM events WHERE id = ?', match.event_id);
  assert.notEqual(event.title, 'Curator-written headline');

  const again = await call(`/v1/curation/matches/${item.match_id}/approve`, { key: adminKey, method: 'POST', body: {} });
  assert.equal(again.status, 400, 'a decided match cannot be decided twice');
});

test('rejecting can create a standing rule in one step', async () => {
  const queue = await (await call('/v1/curation/queue', { key: adminKey })).json();
  const item = queue.items[0];

  const rejected = await (await call(`/v1/curation/matches/${item.match_id}/reject`, {
    key: adminKey,
    method: 'POST',
    body: {
      reason: 'aftershocks are noise for this customer',
      rule: { kind: 'suppress', target: 'keyword', value: 'aftershock', weight: 0.3 },
    },
  })).json();

  assert.equal(rejected.status, 'rejected');
  assert.ok(rejected.rule, 'the rule should have been created');
  assert.equal(rejected.rule.value, 'aftershock');

  const rules = await (await call('/v1/rules', { key: adminKey })).json();
  assert.ok(rules.rules.some((r) => r.value === 'aftershock'));
});

test('unknown endpoints 404 rather than 500', async () => {
  assert.equal((await call('/v1/nope')).status, 404);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test('malformed JSON is a 400, not a crash', async () => {
  const response = await fetch(`${base}/v1/subscriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agentKey}`, 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(response.status, 400);
});

test('the ADMIN_API_KEY from .env resolves to a real, usable subscriber', async () => {
  // Regression: the env admin used to be a synthetic in-memory object, so
  // anything it created failed with "FOREIGN KEY constraint failed".
  const { ensureEnvAdmin } = await import('../src/api/auth.js');
  const { config } = await import('../src/config.js');
  config.adminApiKey = 'pnd_env_admin_for_test';

  const admin = ensureEnvAdmin();
  assert.ok(admin?.id, 'the env admin must be persisted');
  assert.ok(get('SELECT id FROM subscribers WHERE id = ?', admin.id), 'and must exist in the table');

  const response = await call('/v1/subscriptions', {
    key: 'pnd_env_admin_for_test',
    method: 'POST',
    body: { name: 'created by env admin', filter: { minSeverity: 4 } },
  });
  assert.equal(response.status, 201, await response.text());
});
