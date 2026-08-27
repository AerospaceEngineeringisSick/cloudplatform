import { db } from '../db/index.js';
import { config } from '../config.js';
import { now, tooMany } from '../util/index.js';

/**
 * Login throttling is deliberately keyed on *both* the account and the source
 * address. Keying on the account alone lets anyone lock a user out; keying on
 * the address alone lets a botnet spray a weak password across both accounts.
 */
export function recordAttempt(key: string, ok: boolean): void {
  db().prepare('INSERT INTO login_attempts (key, at, ok) VALUES (?, ?, ?)').run(
    key,
    now(),
    ok ? 1 : 0,
  );
}

export function failuresSince(key: string, sinceMs: number): number {
  return (
    db()
      .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at >= ? AND ok = 0')
      .get(key, sinceMs) as { n: number }
  ).n;
}

/** Throws 429 when the key is over budget. Call before verifying a password. */
export function assertNotThrottled(key: string): void {
  const windowStart = now() - config.security.loginWindowSec * 1000;
  const failures = failuresSince(key, windowStart);
  if (failures >= config.security.maxLoginAttempts) {
    const oldest = db()
      .prepare(
        'SELECT MIN(at) AS t FROM login_attempts WHERE key = ? AND at >= ? AND ok = 0',
      )
      .get(key, windowStart) as { t: number | null };
    const retryAfter = oldest.t
      ? Math.max(1, Math.ceil((oldest.t + config.security.loginWindowSec * 1000 - now()) / 1000))
      : config.security.loginWindowSec;
    throw tooMany(
      `Too many failed attempts. Try again in ${retryAfter} seconds.`,
      retryAfter,
    );
  }
}

/** Clear the failure budget for a key after a genuine success. */
export function clearAttempts(key: string): void {
  db().prepare('DELETE FROM login_attempts WHERE key = ? AND ok = 0').run(key);
}

export function pruneAttempts(): number {
  const cutoff = now() - Math.max(config.security.loginWindowSec * 1000 * 4, 86_400_000);
  return db().prepare('DELETE FROM login_attempts WHERE at < ?').run(cutoff).changes;
}

/** In-memory sliding window for general API abuse, separate from logins. */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t >= cutoff);
  if (hits.length >= limit) {
    throw tooMany('Rate limit exceeded.', Math.ceil(windowMs / 1000));
  }
  hits.push(Date.now());
  buckets.set(key, hits);
  // Opportunistic cleanup so the map cannot grow without bound.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => t < cutoff)) buckets.delete(k);
    }
  }
}
