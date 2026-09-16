import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch, checkGates, scoreGeo } from '../src/match/engine.js';

const event = (overrides = {}) => ({
  id: 'evt_1',
  title: 'Dockworkers strike shuts Port of Rotterdam terminals',
  summary: 'All container operations suspended.',
  category: 'labor_action',
  severity: 4,
  confidence: 0.8,
  lat: 51.95,
  lon: 4.14,
  radius_km: 50,
  place_name: 'Rotterdam',
  country: 'NL',
  entities: JSON.stringify([{ name: 'Rotterdam', kind: 'port', country: 'NL', lat: 51.95, lon: 4.14 }]),
  ...overrides,
});

const subscription = (filter, extra = {}) => ({
  id: 'sbn_1', name: 'test', filter: JSON.stringify(filter), threshold: 0.45, review_mode: 'auto', ...extra,
});

const source = { id: 'src_1', name: 'Wire', adapter: 'rss', trust: 0.8 };

test('minimum severity is a hard gate', () => {
  const gate = checkGates(event({ severity: 2 }), { minSeverity: 4 });
  assert.equal(gate.passed, false);
  assert.match(gate.reason, /severity 2 below minimum 4/);
});

test('excluded keywords veto regardless of everything else', () => {
  const gate = checkGates(event({ title: 'Opinion: the Rotterdam strike explained' }), { keywordsNone: ['opinion'] });
  assert.equal(gate.passed, false);
  assert.match(gate.reason, /excluded by keyword/);
});

test('required keywords must all be present', () => {
  assert.equal(checkGates(event(), { keywordsAll: ['strike', 'rotterdam'] }).passed, true);
  const missing = checkGates(event(), { keywordsAll: ['strike', 'antwerp'] });
  assert.equal(missing.passed, false);
  assert.match(missing.reason, /antwerp/);
});

test('an unwatched category is a hard gate', () => {
  assert.equal(checkGates(event(), { categories: ['weather'] }).passed, false);
  assert.equal(checkGates(event(), { categories: ['labor_action'] }).passed, true);
});

test('geo scores higher the closer the event is to the watched point', () => {
  const near = scoreGeo(event(), { near: [{ lat: 51.95, lon: 4.14, radiusKm: 500, label: 'Rotterdam' }] });
  const far = scoreGeo(event(), { near: [{ lat: 48.85, lon: 2.35, radiusKm: 500, label: 'Paris' }] });
  assert.ok(near.score > far.score);
  assert.ok(near.score > 0.9, 'dead centre should score near 1');
});

test('an event outside every watched area is rejected when strict', () => {
  const result = scoreGeo(event(), { near: [{ lat: -33.86, lon: 151.20, radiusKm: 100, label: 'Sydney' }] });
  assert.equal(result.score, 0);
  assert.equal(result.hard, true);
});

test('geoStrict:false downgrades instead of rejecting', () => {
  const result = scoreGeo(event(), {
    geoStrict: false,
    near: [{ lat: -33.86, lon: 151.20, radiusKm: 100, label: 'Sydney' }],
  });
  assert.equal(result.hard, false);
});

test('geoMatch "any" is an OR across constraint types', () => {
  // Country matches, radius does not — "any" still passes.
  const result = scoreGeo(event(), {
    countries: ['NL'],
    near: [{ lat: -33.86, lon: 151.20, radiusKm: 100, label: 'Sydney' }],
  });
  assert.ok(result.score > 0);
  assert.equal(result.hard, false);
});

test('geoMatch "all" intersects constraints', () => {
  // This is the Los Angeles bug: a US event 2,000 km from the watched ports
  // must NOT qualify on "country = US" alone.
  const la = event({ lat: 33.73, lon: -118.26, country: 'US', place_name: 'Los Angeles', entities: '[]' });
  const gulfWatch = {
    countries: ['US'],
    geoMatch: 'all',
    near: [{ lat: 29.73, lon: -95.27, radiusKm: 400, label: 'Houston' }],
  };
  const result = scoreGeo(la, gulfWatch);
  assert.equal(result.score, 0);
  assert.equal(result.hard, true);

  const houston = event({ lat: 29.75, lon: -95.30, country: 'US', place_name: 'Houston', entities: '[]' });
  assert.ok(scoreGeo(houston, gulfWatch).score > 0);
});

test('an event with no location gets partial credit, not rejection', () => {
  const unlocated = event({ lat: null, lon: null, country: null, entities: '[]' });
  const result = scoreGeo(unlocated, { near: [{ lat: 51.95, lon: 4.14, radiusKm: 200 }] });
  assert.ok(result.score > 0 && result.score < 0.5);
  assert.equal(result.hard, false);
});

test('scoreMatch returns a reason for every dimension it used', () => {
  const result = scoreMatch(event(), subscription({
    categories: ['labor_action'],
    keywordsAny: ['strike'],
    near: [{ lat: 51.95, lon: 4.14, radiusKm: 500, label: 'Rotterdam' }],
  }), source);

  assert.equal(result.relevant, true);
  const dimensions = result.explain.map((e) => e.dimension);
  for (const expected of ['severity', 'quality', 'geo', 'keywords', 'category', 'total']) {
    assert.ok(dimensions.includes(expected), `missing "${expected}" in the explanation`);
  }
  assert.ok(result.explain.every((e) => typeof e.detail === 'string' && e.detail.length > 0));
});

test('a subscription that expresses nothing is judged on severity and quality alone', () => {
  const result = scoreMatch(event(), subscription({}), source);
  const dimensions = result.explain.filter((e) => e.weight).map((e) => e.dimension);
  assert.deepEqual(dimensions.sort(), ['quality', 'severity']);
});

test('scores stay within 0 and 1', () => {
  for (const severity of [1, 2, 3, 4, 5]) {
    const result = scoreMatch(event({ severity, confidence: 1 }), subscription({ minSeverity: 1 }), source);
    assert.ok(result.score >= 0 && result.score <= 1, `score out of range for severity ${severity}`);
  }
});
