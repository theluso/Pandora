import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDatabase, all, get, run } from '../src/db.js';
import { newId } from '../src/lib/id.js';
import { ingestSource, storeEvent } from '../src/ingest/runner.js';
import { buildEvent } from '../src/ingest/normalize.js';
import { matchEvents, routeFor, eventPayload } from '../src/match/matcher.js';
import { applyRules, ruleMatches } from '../src/match/rules.js';
import { queueApprovedMatches } from '../src/delivery/dispatcher.js';

before(() => useMemoryDatabase());

function makeSource(overrides = {}) {
  const id = newId('src');
  run('INSERT INTO sources (id, name, adapter, config, trust) VALUES (?,?,?,?,?)',
    id, overrides.name ?? 'Test wire', overrides.adapter ?? 'rss',
    JSON.stringify(overrides.config ?? {}), overrides.trust ?? 0.8);
  return get('SELECT * FROM sources WHERE id = ?', id);
}

function makeSubscription(filter, overrides = {}) {
  const subscriberId = newId('sub');
  run('INSERT INTO subscribers (id, name, kind, api_key_hash, api_key_hint) VALUES (?,?,?,?,?)',
    subscriberId, 'tester', 'agent', newId('hash'), 'abcd');
  const id = newId('sbn');
  run(`INSERT INTO subscriptions (id, subscriber_id, name, filter, delivery, review_mode, threshold)
       VALUES (?,?,?,?,?,?,?)`,
    id, subscriberId, overrides.name ?? 'watch', JSON.stringify(filter),
    JSON.stringify(overrides.delivery ?? { channels: [] }),
    overrides.review_mode ?? 'auto', overrides.threshold ?? 0.45);
  return get('SELECT * FROM subscriptions WHERE id = ?', id);
}

test('fixtures ingest into normalised events', async () => {
  const source = makeSource({ name: 'USGS', adapter: 'usgs', trust: 0.98 });
  const result = await ingestSource(source);

  assert.equal(result.error, null);
  assert.ok(result.stored > 0);

  const quake = get("SELECT * FROM events WHERE category = 'earthquake' ORDER BY severity DESC LIMIT 1");
  assert.ok(quake);
  assert.equal(quake.severity, 5);
  assert.ok(Number.isFinite(quake.lat) && Number.isFinite(quake.lon));
});

test('re-ingesting the same source creates no duplicates', async () => {
  const source = get("SELECT * FROM sources WHERE name = 'USGS'");
  const before = get('SELECT COUNT(*) AS n FROM events').n;
  const second = await ingestSource(source);
  const after = get('SELECT COUNT(*) AS n FROM events').n;

  assert.equal(after, before, 'event count must not grow');
  assert.ok(second.duplicates > 0);
});

test('the same story from two outlets is stored once', () => {
  const source = makeSource({ name: 'Outlet A' });
  const other = makeSource({ name: 'Outlet B' });

  const first = storeEvent(buildEvent({
    sourceId: source.id,
    title: 'Rotterdam dockworkers begin strike action at container terminals',
    url: 'https://a.test/1',
    occurredAt: '2026-09-15T08:00:00Z',
  }));
  const second = storeEvent(buildEvent({
    sourceId: other.id,
    title: 'Strike action begins as Rotterdam dockworkers walk out of terminals',
    url: 'https://b.test/9',
    occurredAt: '2026-09-15T13:00:00Z',
  }));

  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
  assert.equal(second.reason, 'near-duplicate');
  assert.equal(second.event.id, first.event.id);

  const cluster = get('SELECT * FROM event_clusters WHERE event_id = ?', first.event.id);
  assert.equal(cluster.seen_count, 2, 'corroboration should be counted');
  assert.ok(second.similarity >= 0.5, 'similarity should be reported');
});

test('matching creates one match per relevant subscription', () => {
  const source = makeSource({ name: 'Europe wire' });
  const subscription = makeSubscription({
    categories: ['labor_action', 'port_disruption'],
    minSeverity: 3,
    near: [{ lat: 51.95, lon: 4.14, radiusKm: 400, label: 'Rotterdam' }],
  }, { name: 'NW Europe' });

  const stored = storeEvent(buildEvent({
    sourceId: source.id,
    title: 'Port of Antwerp suspends all container handling after crane collapse',
    summary: 'Terminal closed until further notice.',
    occurredAt: '2026-09-15T09:00:00Z',
  }));

  const outcomes = matchEvents([stored.event]).filter((o) => o.subscription.id === subscription.id);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'approved');
  assert.ok(outcomes[0].score > 0.45);
});

test('an event is never matched twice to the same subscription', () => {
  const event = get("SELECT * FROM events WHERE title LIKE 'Port of Antwerp%'");
  const before = get('SELECT COUNT(*) AS n FROM matches WHERE event_id = ?', event.id).n;
  matchEvents([event]);
  const after = get('SELECT COUNT(*) AS n FROM matches WHERE event_id = ?', event.id).n;
  assert.equal(after, before);
});

test('hybrid routing sends a low-trust source to review', () => {
  const subscription = { review_mode: 'hybrid' };
  const trusted = routeFor(subscription, 0.9, 0.45, { event: { confidence: 0.9 }, source: { trust: 0.95 } });
  const noisy = routeFor(subscription, 0.9, 0.45, { event: { confidence: 0.9 }, source: { trust: 0.55 } });
  const unsure = routeFor(subscription, 0.9, 0.45, { event: { confidence: 0.4 }, source: { trust: 0.95 } });
  const borderline = routeFor(subscription, 0.5, 0.45, { event: { confidence: 0.9 }, source: { trust: 0.95 } });

  assert.equal(trusted.status, 'approved');
  assert.equal(noisy.status, 'pending');
  assert.equal(unsure.status, 'pending');
  assert.equal(borderline.status, 'pending');
});

test('review mode holds everything, auto mode holds nothing', () => {
  const context = { event: { confidence: 1 }, source: { trust: 1 } };
  assert.equal(routeFor({ review_mode: 'review' }, 0.99, 0.45, context).status, 'pending');
  assert.equal(routeFor({ review_mode: 'auto' }, 0.46, 0.45, context).status, 'approved');
});

test('a block rule vetoes a match entirely', () => {
  const source = makeSource({ name: 'Blocked wire' });
  const event = { title: 'Opinion: the strike is overblown', summary: '', url: 'https://spam.test/x', category: 'labor_action', entities: '[]' };
  const rule = { id: 'rul_1', kind: 'block', target: 'domain', value: 'spam.test', weight: 0 };

  const result = applyRules(0.9, event, source, [rule]);
  assert.equal(result.score, 0);
  assert.ok(result.blocked);
  assert.match(result.blocked.detail, /spam\.test/);
});

test('boost and suppress move the score by their weight', () => {
  const source = makeSource({ name: 'Weighted wire' });
  const event = { title: 'Berth closure at Felixstowe', summary: '', url: '', category: 'port_disruption', entities: '[]' };

  const boosted = applyRules(0.5, event, source, [{ id: 'r1', kind: 'boost', target: 'keyword', value: 'berth closure', weight: 0.2 }]);
  assert.ok(Math.abs(boosted.score - 0.7) < 1e-9);

  const suppressed = applyRules(0.5, event, source, [{ id: 'r2', kind: 'suppress', target: 'keyword', value: 'berth closure', weight: 0.2 }]);
  assert.ok(Math.abs(suppressed.score - 0.3) < 1e-9);
});

test('a require rule gates anything without the required signal', () => {
  const source = makeSource({ name: 'Require wire' });
  const rule = { id: 'r3', kind: 'require', target: 'keyword', value: 'container', weight: 0 };

  const without = applyRules(0.9, { title: 'Bulk terminal delay', summary: '', url: '', entities: '[]' }, source, [rule]);
  assert.equal(without.score, 0);
  assert.ok(without.blocked);

  const with_ = applyRules(0.9, { title: 'Container terminal delay', summary: '', url: '', entities: '[]' }, source, [rule]);
  assert.equal(with_.score, 0.9);
  assert.equal(with_.blocked, null);
});

test('rules target places and categories as well as keywords', () => {
  const event = {
    title: 'x', summary: '', url: '', category: 'congestion', country: 'NL',
    entities: JSON.stringify([{ name: 'Rotterdam' }]),
  };
  assert.ok(ruleMatches({ target: 'place', value: 'rotterdam' }, event, null));
  assert.ok(ruleMatches({ target: 'category', value: 'congestion' }, event, null));
  assert.ok(ruleMatches({ target: 'country', value: 'nl' }, event, null));
  assert.ok(!ruleMatches({ target: 'place', value: 'antwerp' }, event, null));
});

test('approved matches are always queued for pull, even with no webhook', () => {
  const queued = queueApprovedMatches();
  assert.ok(queued > 0);
  const pulls = all("SELECT * FROM deliveries WHERE channel = 'pull'");
  assert.ok(pulls.length > 0);
  assert.ok(pulls.every((d) => d.status === 'succeeded'));
});

test('a webhook channel adds a pending delivery alongside the pull record', () => {
  const source = makeSource({ name: 'Hook wire' });
  const subscription = makeSubscription({ minSeverity: 1 }, {
    name: 'hooked',
    delivery: { channels: [{ type: 'webhook', url: 'https://receiver.test/hook', secret: 's3cret' }] },
  });

  const stored = storeEvent(buildEvent({
    sourceId: source.id,
    title: 'Suez Canal transit suspended after grounding',
    occurredAt: '2026-09-15T10:00:00Z',
  }));
  matchEvents([stored.event]);
  queueApprovedMatches();

  const match = get('SELECT * FROM matches WHERE event_id = ? AND subscription_id = ?', stored.event.id, subscription.id);
  assert.ok(match, 'the event should have matched the catch-all subscription');
  const channels = all('SELECT channel, status, endpoint FROM deliveries WHERE match_id = ?', match.id);
  assert.ok(channels.some((c) => c.channel === 'pull' && c.status === 'succeeded'));
  assert.ok(channels.some((c) => c.channel === 'webhook' && c.status === 'pending' && c.endpoint === 'https://receiver.test/hook'));
});

test('the delivered payload is stable and carries its explanation', () => {
  const match = get("SELECT * FROM matches WHERE status IN ('approved','delivered') LIMIT 1");
  const event = get('SELECT * FROM events WHERE id = ?', match.event_id);
  const payload = eventPayload(event, match);

  for (const key of ['id', 'title', 'category', 'severity', 'occurred_at', 'entities', 'match']) {
    assert.ok(key in payload, `payload is missing "${key}"`);
  }
  assert.ok(Array.isArray(payload.match.explain));
  assert.equal(typeof payload.match.score, 'number');
});

test('a curator edit changes the payload but never the stored event', () => {
  const match = get("SELECT * FROM matches WHERE status IN ('approved','delivered') LIMIT 1");
  run("UPDATE matches SET override = ? WHERE id = ?", JSON.stringify({ title: 'Curator headline', severity: 5, note: 'verified by ops' }), match.id);

  const updated = get('SELECT * FROM matches WHERE id = ?', match.id);
  const event = get('SELECT * FROM events WHERE id = ?', match.event_id);
  const payload = eventPayload(event, updated);

  assert.equal(payload.title, 'Curator headline');
  assert.equal(payload.severity, 5);
  assert.equal(payload.match.curator_note, 'verified by ops');
  assert.notEqual(event.title, 'Curator headline', 'the source event must stay untouched');
});

test('a new subscription is backfilled from recent events', async () => {
  const { backfillSubscription } = await import('../src/match/matcher.js');

  // Events already exist from the earlier tests in this file.
  const subscription = makeSubscription(
    { categories: ['earthquake'], minSeverity: 4 },
    { name: 'late arrival' },
  );

  const before = get('SELECT COUNT(*) AS n FROM matches WHERE subscription_id = ?', subscription.id).n;
  assert.equal(before, 0, 'a fresh subscription starts with nothing');

  // The fixtures are dated, so widen the window past the default 24 hours.
  const result = backfillSubscription(subscription, { hours: 24 * 365 * 5 });
  assert.ok(result.scanned > 0);
  assert.ok(result.matched > 0, 'backfill should find the stored earthquakes');

  const after = get('SELECT COUNT(*) AS n FROM matches WHERE subscription_id = ?', subscription.id).n;
  assert.equal(after, result.matched);
});

test('backfill can be switched off', async () => {
  const { backfillSubscription } = await import('../src/match/matcher.js');
  const subscription = makeSubscription({ minSeverity: 1 }, { name: 'no backfill' });
  assert.deepEqual(backfillSubscription(subscription, { hours: 0 }), { scanned: 0, matched: 0 });
});

test('backfill never re-judges an event it already decided', async () => {
  const { backfillSubscription } = await import('../src/match/matcher.js');
  const subscription = get("SELECT * FROM subscriptions WHERE name = 'late arrival'");
  const before = get('SELECT COUNT(*) AS n FROM matches WHERE subscription_id = ?', subscription.id).n;
  backfillSubscription(subscription, { hours: 24 * 365 * 5 });
  const after = get('SELECT COUNT(*) AS n FROM matches WHERE subscription_id = ?', subscription.id).n;
  assert.equal(after, before, 'running backfill twice must not duplicate matches');
});
