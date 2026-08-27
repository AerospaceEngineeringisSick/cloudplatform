import { randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random identifier. 16 bytes ≈ 128 bits of entropy. */
export function newId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison that tolerates unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not leak the length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function now(): number {
  return Date.now();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** An error carrying an HTTP status, so routes can throw instead of branching. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string) => new HttpError(400, 'bad_request', msg);
export const unauthorized = (msg = 'Authentication required') =>
  new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not permitted') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const tooMany = (msg: string, retryAfterSec: number) =>
  new HttpError(429, 'rate_limited', msg, { retryAfterSec });

/** Run a promise with a hard timeout so a hung mount cannot stall a request. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HttpError(504, 'timeout', `${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounded concurrency map — keeps `du` style fan-out from swamping the disk. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Rolling rate estimate from cumulative counters. */
export class RateTracker {
  private last: { value: number; at: number } | null = null;

  sample(value: number, at: number = Date.now()): number {
    const prev = this.last;
    this.last = { value, at };
    if (!prev) return 0;
    const dt = (at - prev.at) / 1000;
    if (dt <= 0) return 0;
    const delta = value - prev.value;
    // Counters reset on reboot or interface flap; report zero rather than a spike.
    if (delta < 0) return 0;
    return delta / dt;
  }
}
