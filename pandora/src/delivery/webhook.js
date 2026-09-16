import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * ============================================================================
 * WEBHOOK SIGNING
 * ============================================================================
 * When we POST an event to a customer's server, they need to know it really
 * came from us and was not tampered with in transit. So we send two headers:
 *
 *   X-Pandora-Timestamp: 1789574400
 *   X-Pandora-Signature: sha256=<hex>
 *
 * where the signature is HMAC-SHA256 over "<timestamp>.<body>" using a secret
 * only we and they know. The timestamp is inside the signed string, so an
 * attacker cannot replay yesterday's alert today.
 *
 * This is the same scheme Stripe and GitHub use — receivers will already
 * recognise it, which matters when your customer is an engineer in a hurry.
 * ============================================================================
 */

export function signPayload(body, timestamp, secret = config.webhookSigningSecret) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** The verification a receiver runs. Exported so we can ship it in the docs. */
export function verifySignature(body, timestamp, signature, secret, toleranceSeconds = 300) {
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(body, timestamp, secret));
  const received = Buffer.from(String(signature));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** POST once. The caller owns the retry policy. */
export async function postWebhook(endpoint, payload, { secret, timeoutMs = config.webhookTimeoutMs } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': config.userAgent,
        'x-pandora-timestamp': String(timestamp),
        'x-pandora-signature': signPayload(body, timestamp, secret ?? config.webhookSigningSecret),
        'x-pandora-event-id': payload.event?.id ?? payload.id ?? '',
      },
      body,
    });
    const text = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, body: text.slice(0, 300) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exponential backoff with jitter: ~30s, 2m, 8m, 32m, 2h.
 * Jitter stops every failed delivery in a batch retrying in lockstep and
 * hammering a customer's server the moment it comes back up.
 */
export function nextRetryDelayMs(attempt) {
  const base = 30_000 * 4 ** (attempt - 1);
  const jitter = base * 0.2 * Math.random();
  return Math.min(base + jitter, 2 * 60 * 60 * 1000);
}
