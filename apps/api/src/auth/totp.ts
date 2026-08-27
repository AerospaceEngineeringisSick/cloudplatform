import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const PERIOD_SEC = 30;
/** Accept one step either side, covering ordinary clock drift. */
const WINDOW = 1;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The counter value for a given time — exported so replay checks can store it. */
export function stepFor(at: number = Date.now()): number {
  return Math.floor(at / 1000 / PERIOD_SEC);
}

function codeForStep(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export function generateCode(secretBase32: string, at: number = Date.now()): string {
  return codeForStep(base32Decode(secretBase32), stepFor(at));
}

export interface TotpVerification {
  valid: boolean;
  /** The step the code matched, so callers can reject replays. */
  step: number | null;
}

/**
 * Verify a submitted code. `minStep` rejects any step already consumed —
 * without it, a code stays valid for its whole 30-second window and can be
 * replayed by anyone who observes it.
 */
export function verifyCode(
  secretBase32: string,
  token: string,
  minStep = 0,
  at: number = Date.now(),
): TotpVerification {
  const cleaned = token.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { valid: false, step: null };

  const secret = base32Decode(secretBase32);
  const current = stepFor(at);
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const step = current + offset;
    if (step <= minStep) continue;
    const expected = codeForStep(secret, step);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(cleaned, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) return { valid: true, step };
  }
  return { valid: false, step: null };
}

/** otpauth:// URI that Aegis, 1Password, Bitwarden and Google Authenticator read. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SEC),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params}`;
}
