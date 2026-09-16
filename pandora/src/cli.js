#!/usr/bin/env node
import { unlinkSync, existsSync } from 'node:fs';
import { config } from './config.js';
import { db, all, get } from './db.js';
import { logger } from './lib/log.js';
import { seed } from './seed.js';
import { ingestAll } from './ingest/runner.js';
import { matchEvents } from './match/matcher.js';
import { flushDeliveries } from './delivery/dispatcher.js';
import { startServer } from './api/server.js';

const log = logger('cli');

/** One full turn of the machine: poll → normalise → match → deliver. */
export async function runPipeline({ force = true } = {}) {
  const { results, newEvents } = await ingestAll({ force });
  const outcomes = matchEvents(newEvents);
  const deliveries = await flushDeliveries();

  return {
    sources: results,
    newEvents: newEvents.length,
    matched: outcomes.filter((o) => o.matchId).length,
    pending: outcomes.filter((o) => o.status === 'pending').length,
    approved: outcomes.filter((o) => o.status === 'approved').length,
    suppressed: outcomes.filter((o) => o.status === 'suppressed').length,
    delivered: deliveries.filter((d) => d.ok).length,
  };
}

const COMMANDS = {
  async setup() {
    db();
    const created = seed();
    if (created.keys.length) {
      console.log('\n  ┌─ API KEYS — copy these now, they are not stored in readable form ─┐');
      for (const entry of created.keys) {
        console.log(`  │  ${entry.role.padEnd(18)} ${entry.key}`);
      }
      console.log('  └────────────────────────────────────────────────────────────────────┘\n');
    }
    console.log('Next:  npm run demo     (run the pipeline once and show what happened)');
    console.log('       npm run dev      (start the dashboard + API)\n');
  },

  async ingest() {
    db();
    const summary = await runPipeline();
    console.log(JSON.stringify(summary, null, 2));
  },

  /** The two-minute tour: seed, ingest, match, and print what the machine did. */
  async demo() {
    db();
    seed({ quiet: true });
    const summary = await runPipeline();

    console.log('\n══ PIPELINE RUN ═══════════════════════════════════════════════════');
    for (const source of summary.sources) {
      const state = source.error ? `ERROR: ${source.error}` : `${source.stored} new / ${source.fetched} fetched`;
      console.log(`  ${source.source.padEnd(34)} ${state}`);
    }
    console.log(`\n  ${summary.newEvents} new events → ${summary.matched} matches`);
    console.log(`  ${summary.approved} auto-approved · ${summary.pending} awaiting human review · ${summary.suppressed} suppressed by rules`);

    const top = all(
      `SELECT e.title, e.category, e.severity, e.place_name, m.score, m.status, s.name AS sub
         FROM matches m
         JOIN events e ON e.id = m.event_id
         JOIN subscriptions s ON s.id = m.subscription_id
        ORDER BY m.score DESC LIMIT 8`,
    );

    if (top.length) {
      console.log('\n══ TOP MATCHES ════════════════════════════════════════════════════');
      for (const row of top) {
        const flag = row.status === 'pending' ? '◻ review' : row.status === 'suppressed' ? '✕ blocked' : '✓ sent  ';
        console.log(`  ${flag}  ${String(row.score.toFixed(2)).padStart(4)}  [${row.category}/${row.severity}] ${row.title.slice(0, 62)}`);
        console.log(`            └─ ${row.sub}${row.place_name ? ` · ${row.place_name}` : ''}`);
      }
    }

    const pending = get("SELECT COUNT(*) AS n FROM matches WHERE status='pending'").n;
    console.log(`\n  ${pending} item(s) are waiting for a curator.`);
    console.log('  Start the dashboard to work the queue:  npm run dev\n');
  },

  async serve() {
    db();
    seed({ quiet: true });
    await startServer();

    // The background worker runs in the same process. Fine for one machine;
    // split it out when you need more than one.
    const interval = config.pollIntervalSeconds * 1000;
    const tick = async () => {
      try {
        const summary = await runPipeline({ force: false });
        if (summary.newEvents || summary.delivered) {
          log.info(`worker: ${summary.newEvents} new, ${summary.matched} matched, ${summary.delivered} delivered`);
        }
      } catch (error) {
        log.error('worker tick failed', error);
      }
    };
    setTimeout(tick, 2000);
    setInterval(tick, interval).unref?.();
    log.info(`Worker polling every ${config.pollIntervalSeconds}s`);
  },

  /** Ingest loop with no web server — for running on a schedule (cron, systemd). */
  async worker() {
    db();
    const summary = await runPipeline();
    log.info('worker run complete', summary);
    process.exit(0);
  },

  async reset() {
    if (existsSync(config.databasePath)) {
      unlinkSync(config.databasePath);
      for (const suffix of ['-wal', '-shm']) {
        const path = `${config.databasePath}${suffix}`;
        if (existsSync(path)) unlinkSync(path);
      }
      console.log(`Deleted ${config.databasePath}`);
    } else {
      console.log('Nothing to delete.');
    }
  },
};

const command = process.argv[2] ?? 'help';
if (!COMMANDS[command]) {
  console.log(`
  Pandora Events

    npm run setup     Create the database, seed sources and print API keys
    npm run demo      Run the pipeline once and show what happened
    npm run dev       Start the dashboard + agent API (with background worker)
    npm run ingest    Run one ingest/match/deliver cycle
    npm run worker    Same as ingest, for cron or systemd
    npm run reset     Delete the database and start over
    npm test          Run the test suite
`);
  process.exit(command === 'help' ? 0 : 1);
}

COMMANDS[command]().catch((error) => {
  log.error(`"${command}" failed`, error);
  process.exit(1);
});
