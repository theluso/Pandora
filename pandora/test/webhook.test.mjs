import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload, verifySignature, nextRetryDelayMs } from '../src/delivery/webhook.js';

const SECRET = 'test-signing-secret';

test('a signature verifies against the same body and secret', () => {
  const body = JSON.stringify({ event: { id: 'evt_1' } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(body, timestamp, SECRET);
  assert.ok(verifySignature(body, timestamp, signature, SECRET));
});

test('a tampered body fails verification', () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload('{"severity":2}', timestamp, SECRET);
  assert.equal(verifySignature('{"severity":5}', timestamp, signature, SECRET), false);
});

test('the wrong secret fails verification', () => {
  const body = '{"a":1}';
  const timestamp = Math.floor(Date.now() / 1000);
  assert.equal(verifySignature(body, timestamp, signPayload(body, timestamp, SECRET), 'other-secret'), false);
});

test('an old signature is rejected as a replay', () => {
  const body = '{"a":1}';
  const stale = Math.floor(Date.now() / 1000) - 3600;
  const signature = signPayload(body, stale, SECRET);
  assert.equal(verifySignature(body, stale, signature, SECRET), false,
    'an hour-old delivery must not be accepted');
  assert.ok(verifySignature(body, stale, signature, SECRET, 7200),
    'unless the receiver widens the tolerance');
});

test('the timestamp is inside the signed string', () => {
  const body = '{"a":1}';
  const now = Math.floor(Date.now() / 1000);
  assert.notEqual(signPayload(body, now, SECRET), signPayload(body, now + 1, SECRET));
});

test('retry backoff grows and is capped', () => {
  const delays = [1, 2, 3, 4, 5].map(nextRetryDelayMs);
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] > delays[i - 1], 'each retry must wait longer than the last');
  }
  assert.ok(nextRetryDelayMs(20) <= 2 * 60 * 60 * 1000, 'backoff must be capped at two hours');
  assert.ok(delays[0] >= 30_000, 'the first retry waits at least 30s');
});
