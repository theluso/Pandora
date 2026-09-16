import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, sortable-ish, URL-safe id with a type prefix: `evt_k3f9x2...` */
export function newId(prefix) {
  const now = Date.now();
  let time = '';
  let n = now;
  while (n > 0) {
    time = ALPHABET[n % 36] + time;
    n = Math.floor(n / 36);
  }
  return `${prefix}_${time}${randomBytes(5).toString('hex')}`;
}

/** API keys are shown once and stored only as a hash. */
export function newApiKey() {
  return `pnd_${randomBytes(24).toString('base64url')}`;
}

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sha1(input) {
  return createHash('sha1').update(input).digest('hex');
}
