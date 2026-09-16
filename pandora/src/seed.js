import { all, get, run } from './db.js';
import { newId } from './lib/id.js';
import { createSubscriber, ensureEnvAdmin } from './api/auth.js';
import { config } from './config.js';

/**
 * Opinionated starting content.
 *
 * The four sources below are all free and key-less. The four subscriptions
 * are a worked example of a mid-size freight forwarder's actual watchlist —
 * copy them, then bend them to your customer.
 */

const SOURCES = [
  {
    name: 'USGS Earthquakes (M4.5+)',
    adapter: 'usgs',
    trust: 0.98,
    poll_seconds: 300,
    config: { url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson' },
  },
  {
    name: 'NWS Weather Alerts (US)',
    adapter: 'nws',
    trust: 0.95,
    poll_seconds: 300,
    config: { url: 'https://api.weather.gov/alerts/active' },
  },
  {
    name: 'GDELT — supply chain news',
    adapter: 'gdelt',
    trust: 0.55, // wide net, noisy: deliberately the least trusted source
    poll_seconds: 900,
    config: {
      query: '(port OR shipping OR freight OR terminal) AND (strike OR closure OR congestion OR disruption)',
      maxRecords: 60,
      timespan: '1d',
    },
  },
  {
    name: 'Maritime trade wire (RSS)',
    adapter: 'rss',
    trust: 0.8,
    poll_seconds: 600,
    config: {
      url: 'https://example-maritime.test/feed',
      keywordsAny: ['port', 'terminal', 'vessel', 'strike', 'canal', 'rail', 'freight', 'barge'],
    },
  },
];

const SUBSCRIPTIONS = [
  {
    name: 'North-west Europe port disruption',
    review_mode: 'hybrid',
    threshold: 0.45,
    filter: {
      categories: ['port_disruption', 'labor_action', 'congestion', 'infrastructure'],
      minSeverity: 3,
      near: [
        { lat: 51.95, lon: 4.14, radiusKm: 600, label: 'Rotterdam hub' },
      ],
      places: ['Rotterdam', 'Antwerp', 'Hamburg', 'Felixstowe', 'Le Havre', 'Bremerhaven'],
      keywordsNone: ['opinion', 'interview'],
    },
    delivery: { channels: [] },
  },
  {
    name: 'Global chokepoint watch',
    review_mode: 'auto',
    threshold: 0.4,
    filter: {
      minSeverity: 3,
      places: ['Suez Canal', 'Panama Canal', 'Strait of Hormuz', 'Bab el-Mandeb', 'Strait of Malacca', 'Red Sea', 'Bosphorus'],
      geoStrict: true,
    },
    delivery: { channels: [] },
  },
  {
    name: 'US Gulf & South-east weather impact',
    review_mode: 'hybrid',
    threshold: 0.5,
    filter: {
      categories: ['weather', 'flood', 'port_disruption'],
      minSeverity: 3,
      countries: ['US'],
      near: [
        { lat: 29.73, lon: -95.27, radiusKm: 400, label: 'Houston' },
        { lat: 32.13, lon: -81.14, radiusKm: 400, label: 'Savannah' },
      ],
      // "in the US AND near one of these ports" — without this, a Los Angeles
      // storm qualifies on the country alone.
      geoMatch: 'all',
    },
    delivery: { channels: [] },
  },
  {
    name: 'Anything critical, anywhere',
    review_mode: 'auto',
    threshold: 0.3,
    filter: { minSeverity: 5 },
    delivery: { channels: [] },
  },
];

export function seed({ quiet = false } = {}) {
  const say = (message) => { if (!quiet) console.log(message); };
  const created = { sources: 0, subscriptions: 0, rules: 0, keys: [] };

  for (const source of SOURCES) {
    if (get('SELECT id FROM sources WHERE name = ?', source.name)) continue;
    run(
      'INSERT INTO sources (id, name, adapter, config, trust, poll_seconds) VALUES (?,?,?,?,?,?)',
      newId('src'), source.name, source.adapter, JSON.stringify(source.config), source.trust, source.poll_seconds,
    );
    created.sources += 1;
  }

  // The admin/curator identity. If ADMIN_API_KEY is set in .env we bind to
  // that; otherwise we mint one and print it exactly once.
  let admin = ensureEnvAdmin() ?? get('SELECT * FROM subscribers WHERE is_admin = 1');
  if (!admin) {
    const result = createSubscriber({ name: 'Curator', kind: 'human', isAdmin: true });
    admin = result.subscriber;
    created.keys.push({ role: 'curator (admin)', name: 'Curator', key: result.apiKey });
  }

  // A demo agent — the AI system on the customer's side.
  let agent = get("SELECT * FROM subscribers WHERE name = 'Demo logistics agent'");
  if (!agent) {
    const result = createSubscriber({ name: 'Demo logistics agent', kind: 'agent' });
    agent = result.subscriber;
    created.keys.push({ role: 'agent', name: 'Demo logistics agent', key: result.apiKey });
  }

  for (const subscription of SUBSCRIPTIONS) {
    if (get('SELECT id FROM subscriptions WHERE name = ?', subscription.name)) continue;
    run(
      `INSERT INTO subscriptions (id, subscriber_id, name, filter, delivery, review_mode, threshold)
       VALUES (?,?,?,?,?,?,?)`,
      newId('sbn'), agent.id, subscription.name,
      JSON.stringify(subscription.filter), JSON.stringify(subscription.delivery),
      subscription.review_mode, subscription.threshold,
    );
    created.subscriptions += 1;
  }

  // One starter rule, to show the mechanism: trade-press filler is never an
  // operational event, so suppress it everywhere.
  if (!get("SELECT id FROM rules WHERE value = 'opinion' AND subscription_id IS NULL")) {
    run(
      `INSERT INTO rules (id, subscription_id, kind, target, value, weight, note, created_by)
       VALUES (?,NULL,?,?,?,?,?,?)`,
      newId('rul'), 'suppress', 'keyword', 'opinion', 0.35,
      'Opinion pieces are commentary, not operational signals', admin.id,
    );
    created.rules += 1;
  }

  say(`Seeded: ${created.sources} sources, ${created.subscriptions} subscriptions, ${created.rules} rule(s)`);
  return created;
}
