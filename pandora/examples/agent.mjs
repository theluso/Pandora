#!/usr/bin/env node
/**
 * A complete Pandora-consuming agent, in one file.
 *
 *   node examples/agent.mjs pnd_your_agent_key
 *
 * It does the three things every integration has to do:
 *   1. declare what it cares about (create a subscription)
 *   2. poll the feed with a cursor so nothing is missed or repeated
 *   3. act on what arrives, and tell Pandora whether it was useful
 *
 * Step 3 is the one people skip. Don't: feedback is what makes the matching
 * better over time, and it costs one HTTP call.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.PANDORA_URL ?? 'http://127.0.0.1:4180';
const KEY = process.argv[2] ?? process.env.PANDORA_KEY;
const CURSOR_FILE = new URL('./.agent-cursor', import.meta.url).pathname;

if (!KEY) {
  console.error('Usage: node examples/agent.mjs <agent-api-key>');
  console.error('Get one from `npm run setup`, or mint one via POST /v1/admin/subscribers');
  process.exit(1);
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${payload.error ?? 'unknown error'}`);
  return payload;
}

// ── 1. Declare what this agent cares about ──────────────────────────────────
async function ensureSubscription() {
  const { subscriptions } = await api('/v1/subscriptions');
  const existing = subscriptions.find((s) => s.name === 'Agent: European supply chain');
  if (existing) return existing;

  const { subscription, backfill } = await api('/v1/subscriptions', {
    method: 'POST',
    body: {
      name: 'Agent: European supply chain',
      filter: {
        categories: ['port_disruption', 'labor_action', 'congestion', 'infrastructure', 'weather'],
        minSeverity: 3,
        near: [
          { lat: 51.95, lon: 4.14, radiusKm: 700, label: 'Rotterdam hub' },
          { lat: 30.58, lon: 32.35, radiusKm: 300, label: 'Suez Canal' },
        ],
        keywordsNone: ['opinion', 'interview'],
      },
      // Let a human check anything the machine is unsure about before we act.
      review_mode: 'hybrid',
      threshold: 0.45,
      // Seed the feed from recent history so the first poll is not empty.
      backfill_hours: 24 * 365,
    },
  });

  console.log(`Created subscription ${subscription.id}`);
  if (backfill) console.log(`  backfill: ${backfill.matched} match(es) from ${backfill.scanned} stored events`);
  return subscription;
}

// ── 2. Poll with a cursor ───────────────────────────────────────────────────
const loadCursor = () => (existsSync(CURSOR_FILE) ? readFileSync(CURSOR_FILE, 'utf8').trim() : '');
const saveCursor = (cursor) => writeFileSync(CURSOR_FILE, cursor ?? '');

async function poll() {
  let cursor = loadCursor();
  let total = 0;

  // Drain every page, not just the first — after an outage there may be many.
  while (true) {
    const query = new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}) });
    const page = await api(`/v1/events?${query}`);
    if (!page.events.length) break;

    for (const event of page.events) await handle(event);

    total += page.events.length;
    cursor = page.next_cursor;
    // Save after each page: a crash mid-run resumes, it does not replay.
    saveCursor(cursor);
    if (!page.has_more) break;
  }

  return total;
}

// ── 3. Act, then report back ────────────────────────────────────────────────
async function handle(event) {
  const where = event.location?.place ?? 'location unknown';
  const reviewed = event.match?.reviewed ? ' [human-reviewed]' : '';
  console.log(`\n▸ [${event.category}/${event.severity}] ${event.title}`);
  console.log(`  ${where} · score ${event.match.score.toFixed(2)}${reviewed}`);
  if (event.match.curator_note) console.log(`  curator: ${event.match.curator_note}`);

  // ── your business logic goes here ──
  let useful = true;
  if (event.severity >= 4 && ['port_disruption', 'labor_action'].includes(event.category)) {
    const ports = event.entities.filter((e) => e.kind === 'port').map((e) => e.name);
    console.log(`  → ACTION: reroute planning for ${ports.join(', ') || where}`);
  } else if (event.category === 'weather' && event.severity === 5) {
    console.log('  → ACTION: notify the operations desk, hold outbound bookings');
  } else {
    console.log('  → logged, no action taken');
    useful = false;
  }

  // Tell Pandora whether this was worth sending. This is the feedback loop:
  // it surfaces misfiring subscriptions before the customer complains.
  await api(`/v1/events/${event.id}/feedback`, {
    method: 'POST',
    body: { verdict: useful ? 'useful' : 'not_useful', reason: useful ? 'triggered rerouting' : 'no action needed' },
  }).catch(() => {});
}

// ── Run ─────────────────────────────────────────────────────────────────────
const me = await api('/v1/me');
console.log(`Connected to ${BASE} as "${me.name}" (${me.kind})`);

await ensureSubscription();

const count = await poll();
console.log(`\n${count} event(s) processed. Cursor saved to ${CURSOR_FILE}`);
console.log('Run again to collect only what is new — nothing is repeated.');
