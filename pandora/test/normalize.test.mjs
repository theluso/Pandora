import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, inferSeverity, noiseScore, buildEvent, dedupeHash, clusterKey, toIso,
} from '../src/ingest/normalize.js';
import { matchesSignal } from '../src/ingest/taxonomy.js';
import { findPlaces } from '../src/ingest/gazetteer.js';

test('signal matching respects word boundaries', () => {
  // The bug this guards against: a plain substring check for "port" matches
  // the word "reported", so every wire story ("Reported by Reuters") was
  // classified as a port disruption.
  assert.ok(matchesSignal('Port of Rotterdam closed', 'port*'));
  assert.ok(!matchesSignal('Reported by the wire service', 'port*'));
  assert.ok(!matchesSignal('a portfolio of transport assets', 'port'));
  assert.ok(matchesSignal('the transport hub', 'transport'));
});

test('stems match every inflection of a word', () => {
  for (const phrase of ['closed', 'closure', 'closing', 'will close']) {
    assert.ok(matchesSignal(`The port is ${phrase}`, 'clos*'), phrase);
  }
  assert.ok(!matchesSignal('watching closely for updates', 'clos*') === false);
});

test('multi-word phrases tolerate any separator', () => {
  assert.ok(matchesSignal('a port closure was announced', 'port clos*'));
  assert.ok(matchesSignal('port-closing procedures', 'port clos*'));
  assert.ok(matchesSignal('the port is closed', 'port clos*'));
});

test('classify picks the dominant category', () => {
  assert.equal(classify('Dockworkers begin a 48-hour strike at the terminal').category, 'labor_action');
  // Cause vs effect: when a storm closes a port, the OPERATIONAL event is the
  // closure — that is what a freight system acts on. The weather is recorded
  // as the runner-up so a curator can flip it if they disagree.
  const storm = classify('Typhoon forces the port to close all berths');
  assert.equal(storm.category, 'port_disruption');
  assert.ok(storm.alternatives.includes('weather'));
  assert.equal(classify('Ransomware takes terminal IT systems offline').category, 'cyber');
  assert.equal(classify('EU adopts new sanctions package on listed vessels').category, 'regulatory');
});

test('a corporate appointment is not a port disruption', () => {
  const result = classify('Maersk appoints new chief financial officer. Reported by example.test.');
  assert.notEqual(result.category, 'port_disruption');
});

test('severity reads stems, not exact tenses', () => {
  // "close"/"halt" must score the same as "closed"/"halted".
  assert.equal(inferSeverity('Typhoon forces terminals to close and halt all vessel movements').severity, 5);
  assert.equal(inferSeverity('Terminals were closed and operations halted').severity, 4);
});

test('a category floor stops calm wording hiding a serious event', () => {
  const calm = 'Bulk carrier approached by drone near Bab el-Mandeb, crew safe';
  assert.ok(inferSeverity(calm).severity < 3, 'no floor applied without a category');
  assert.ok(inferSeverity(calm, { category: 'security' }).severity >= 3, 'security floor applies');
});

test('recovery language caps severity', () => {
  const result = inferSeverity('Port reopened after closure, normal operations resume', { category: 'port_disruption' });
  assert.ok(result.severity <= 3);
  assert.ok(result.reasons.some((r) => r.includes('caps severity')));
});

test('noise detection flags trade-press filler', () => {
  assert.ok(noiseScore('Opinion: the next decade of shipping').isNoise);
  assert.ok(noiseScore('Interview with the terminal chief').isNoise);
  assert.ok(!noiseScore('Port of Rotterdam closed by strike').isNoise);
});

test('places are extracted from free text with coordinates', () => {
  const hits = findPlaces('Strike halts Rotterdam; vessels reroute around the Cape of Good Hope');
  const names = hits.map((h) => h.name);
  assert.ok(names.includes('Rotterdam'));
  assert.ok(names.includes('Cape of Good Hope'));
  assert.equal(hits.find((h) => h.name === 'Rotterdam').country, 'NL');
});

test('place extraction does not fire on substrings', () => {
  assert.deepEqual(findPlaces('A corkscrew factory in Portugal'), []);
});

test('buildEvent geo-locates a text-only headline', () => {
  const event = buildEvent({
    sourceId: 'src_1',
    title: 'Dockworkers strike shuts Port of Rotterdam',
    summary: 'Container operations suspended indefinitely.',
    occurredAt: '2026-09-15T08:00:00Z',
  });
  assert.equal(event.category, 'labor_action');
  assert.equal(event.place_name, 'Rotterdam');
  assert.equal(event.country, 'NL');
  assert.ok(Number.isFinite(event.lat) && Number.isFinite(event.lon));
  assert.equal(event.severity, 5); // "indefinitely"
});

test('dedupe prefers the external id, then the url, then the title', () => {
  const byId = dedupeHash({ sourceId: 's', externalId: 'abc', title: 'x', url: 'https://a.test' });
  assert.equal(byId, dedupeHash({ sourceId: 's', externalId: 'abc', title: 'different', url: 'https://b.test' }));

  const byUrl = dedupeHash({ sourceId: 's', title: 'x', url: 'https://a.test/story?utm=1' });
  assert.equal(byUrl, dedupeHash({ sourceId: 's', title: 'y', url: 'https://a.test/story?utm=2' }),
    'query strings must not create a new event');
});

test('cluster key groups the same story from different outlets', () => {
  const a = clusterKey({ category: 'labor_action', places: [{ name: 'Rotterdam' }], title: 'Rotterdam dockworkers begin strike action', occurredAt: '2026-09-15T08:00:00Z' });
  const b = clusterKey({ category: 'labor_action', places: [{ name: 'Rotterdam' }], title: 'Strike action begins as Rotterdam dockworkers walk out', occurredAt: '2026-09-15T14:00:00Z' });
  assert.equal(a, b);
});

test('toIso accepts epoch millis, RFC-822 and ISO', () => {
  assert.equal(toIso(1789556400000), new Date(1789556400000).toISOString());
  assert.equal(toIso('Mon, 14 Sep 2026 06:00:00 GMT'), '2026-09-14T06:00:00.000Z');
  assert.equal(toIso('2026-09-15T08:00:00Z'), '2026-09-15T08:00:00.000Z');
  assert.equal(toIso('not a date'), null);
});

test('the anchor location comes from the headline, not the body', () => {
  // Regression: gazetteer hit order is arbitrary, so an Antwerp story whose
  // body mentioned Rotterdam was being filed under Rotterdam.
  const event = buildEvent({
    sourceId: 'src_1',
    title: 'Antwerp-Bruges reports berth delays of up to 36 hours',
    summary: 'Vessels diverted from Rotterdam are adding to the backlog.',
    occurredAt: '2026-09-15T09:40:00Z',
  });
  assert.equal(event.place_name, 'Antwerp');
  assert.equal(event.country, 'BE');
  assert.ok(event.entities.some((e) => e.name === 'Rotterdam'), 'Rotterdam stays as a secondary entity');
});

test('a port in the headline beats a region in the headline', () => {
  const event = buildEvent({
    sourceId: 'src_1',
    title: 'Red Sea diversions push volumes through Singapore',
    occurredAt: '2026-09-15T09:40:00Z',
  });
  assert.equal(event.place_name, 'Singapore');
});
