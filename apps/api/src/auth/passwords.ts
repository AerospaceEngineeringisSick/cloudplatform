import { hash, verify, Algorithm } from '@node-rs/argon2';
import { randomBytes, createHash } from 'node:crypto';
import { base32Encode } from './totp.js';

/**
 * OWASP's 2024 argon2id baseline: 19 MiB, 2 iterations, 1 lane.
 * Comfortably under a second on an EPYC core while staying GPU-hostile.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain, OPTIONS);
  } catch {
    // A malformed hash must read as "wrong password", never as a crash.
    return false;
  }
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Length does the heavy lifting. We ask for 12 characters and reject the
 * handful of catastrophically common choices rather than demanding symbols,
 * which mostly produces `Password1!`.
 */
const COMMON = new Set([
  'password', 'password1', 'password123', '123456789', 'qwertyuiop',
  'letmein123', 'administrator', 'changeme123', 'welcome123', 'iloveyou123',
]);

export function checkPasswordPolicy(plain: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (plain.length < 12) problems.push('Must be at least 12 characters long.');
  if (plain.length > 200) problems.push('Must be 200 characters or fewer.');
  if (COMMON.has(plain.toLowerCase())) problems.push('That password is too common.');
  if (/^(.)\1+$/.test(plain)) problems.push('Cannot be a single repeated character.');
  return { ok: problems.length === 0, problems };
}

/** Recovery codes are shown once and stored only as hashes. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(10)).slice(0, 16);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

/**
 * Recovery codes carry full entropy already, so a fast hash is appropriate
 * here — unlike passwords, there is nothing to slow down a guesser about.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/-/g, '').toUpperCase()).digest('hex');
}

/** Session tokens are random; store only the digest so a DB leak is not a login. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}
