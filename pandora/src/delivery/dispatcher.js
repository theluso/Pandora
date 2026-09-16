import { all, get, run, parseJson } from '../db.js';
import { newId } from '../lib/id.js';
import { logger } from '../lib/log.js';
import { config } from '../config.js';
import { eventPayload } from '../match/matcher.js';
import { postWebhook, nextRetryDelayMs } from './webhook.js';

const log = logger('deliver');

/**
 * Turn approved matches into actual deliveries.
 *
 * Two channels, and the difference matters commercially:
 *   webhook — we push to the customer. Instant, but needs them to run a
 *             server that is reachable and up.
 *   pull    — we hold it, they GET /v1/events when ready. Works behind any
 *             firewall, and is what most AI agents actually want: they poll
 *             on their own schedule and keep a cursor.
 *
 * Every approved match always gets a `pull` record, so nothing is ever lost
 * even when a webhook fails permanently.
 */

export function queueApprovedMatches() {
  const pending = all(
    `SELECT m.* FROM matches m
      WHERE m.status = 'approved'
        AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.match_id = m.id)`,
  );

  for (const match of pending) {
    const subscription = get('SELECT * FROM subscriptions WHERE id = ?', match.subscription_id);
    if (!subscription) continue;
    const delivery = parseJson(subscription.delivery, {});
    const channels = delivery.channels ?? [];

    // The durable record: always available to a polling agent.
    run(
      `INSERT INTO deliveries (id, match_id, channel, endpoint, status) VALUES (?,?,?,?,?)`,
      newId('dlv'),
      match.id,
      'pull',
      null,
      'succeeded',
    );

    for (const channel of channels) {
      if (channel.type !== 'webhook' || !channel.url) continue;
      run(
        `INSERT INTO deliveries (id, match_id, channel, endpoint, status, next_retry_at)
         VALUES (?,?,?,?,?,datetime('now'))`,
        newId('dlv'),
        match.id,
        'webhook',
        channel.url,
        'pending',
      );
    }
  }

  return pending.length;
}

/** Send everything that is due. Safe to call on a timer. */
export async function flushDeliveries({ limit = 50 } = {}) {
  queueApprovedMatches();

  const due = all(
    `SELECT * FROM deliveries
      WHERE channel = 'webhook' AND status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
      ORDER BY created_at LIMIT ?`,
    limit,
  );

  const results = [];
  for (const delivery of due) {
    results.push(await attemptDelivery(delivery));
  }
  return results;
}

export async function attemptDelivery(delivery) {
  const match = get('SELECT * FROM matches WHERE id = ?', delivery.match_id);
  const event = match && get('SELECT * FROM events WHERE id = ?', match.event_id);
  const subscription = match && get('SELECT * FROM subscriptions WHERE id = ?', match.subscription_id);

  if (!match || !event || !subscription) {
    run(`UPDATE deliveries SET status='failed', last_error=?, updated_at=datetime('now') WHERE id=?`,
      'match, event or subscription no longer exists', delivery.id);
    return { id: delivery.id, ok: false, reason: 'orphaned' };
  }

  const channels = parseJson(subscription.delivery, {}).channels ?? [];
  const channel = channels.find((c) => c.type === 'webhook' && c.url === delivery.endpoint);

  const body = {
    type: 'event.delivered',
    delivered_at: new Date().toISOString(),
    subscription: { id: subscription.id, name: subscription.name },
    event: eventPayload(event, match),
  };

  const attempt = delivery.attempts + 1;
  const result = await postWebhook(delivery.endpoint, body, { secret: channel?.secret });

  if (result.ok) {
    run(
      `UPDATE deliveries SET status='succeeded', attempts=?, last_code=?, last_error=NULL,
         next_retry_at=NULL, updated_at=datetime('now') WHERE id=?`,
      attempt, result.status, delivery.id,
    );
    run(`UPDATE matches SET status='delivered' WHERE id=? AND status='approved'`, match.id);
    log.info(`delivered ${event.title.slice(0, 60)} → ${delivery.endpoint} (${result.status})`);
    return { id: delivery.id, ok: true, status: result.status, attempts: attempt };
  }

  const exhausted = attempt >= config.webhookMaxAttempts;
  const nextRetry = exhausted ? null : new Date(Date.now() + nextRetryDelayMs(attempt)).toISOString();

  run(
    `UPDATE deliveries SET status=?, attempts=?, last_code=?, last_error=?, next_retry_at=?,
       updated_at=datetime('now') WHERE id=?`,
    exhausted ? 'failed' : 'pending',
    attempt,
    result.status,
    result.body,
    nextRetry,
    delivery.id,
  );

  if (exhausted) {
    run(`UPDATE matches SET status='failed' WHERE id=? AND status='approved'`, match.id);
    log.error(`gave up on ${delivery.endpoint} after ${attempt} attempts: ${result.body}`);
  } else {
    log.warn(`attempt ${attempt} to ${delivery.endpoint} failed (${result.status}), retrying`);
  }

  return { id: delivery.id, ok: false, status: result.status, attempts: attempt, exhausted };
}
