import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, newId, now, notFound } from '../util/index.js';
import type { UserRow } from './store.js';

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

/**
 * Challenges live in memory with a short TTL. They are single-use by
 * construction: consuming one deletes it, so a replayed response fails.
 */
const challenges = new Map<string, { challenge: string; userId: string; expires: number }>();
const CHALLENGE_TTL_MS = 120_000;

function putChallenge(key: string, challenge: string, userId: string): void {
  challenges.set(key, { challenge, userId, expires: Date.now() + CHALLENGE_TTL_MS });
}

function takeChallenge(key: string): { challenge: string; userId: string } {
  const entry = challenges.get(key);
  challenges.delete(key);
  if (!entry || entry.expires < Date.now()) {
    throw badRequest('That security-key challenge expired. Start again.');
  }
  return entry;
}

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of challenges) if (v.expires < t) challenges.delete(k);
}, 60_000).unref();

export function listPasskeys(userId: string) {
  const rows = db()
    .prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId) as PasskeyRow[];
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export async function startRegistration(user: UserRow) {
  const existing = db()
    .prepare('SELECT id, transports FROM passkeys WHERE user_id = ?')
    .all(user.id) as { id: string; transports: string | null }[];

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: user.username,
    userDisplayName: user.display_name,
    attestationType: 'none',
    // Stops the same key being enrolled twice on one account.
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransportFuture[]) : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
  putChallenge(`reg:${user.id}`, options.challenge, user.id);
  return options;
}

export async function finishRegistration(
  user: UserRow,
  response: RegistrationResponseJSON,
  label: string,
): Promise<void> {
  const { challenge } = takeChallenge(`reg:${user.id}`);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw badRequest('Could not verify that security key.');
  }
  const { credential } = verification.registrationInfo;
  db()
    .prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      credential.id,
      user.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      label.slice(0, 60) || 'Security key',
      now(),
    );
}

export async function startAuthentication(user: UserRow) {
  const rows = db()
    .prepare('SELECT id, transports FROM passkeys WHERE user_id = ?')
    .all(user.id) as { id: string; transports: string | null }[];
  if (rows.length === 0) throw notFound('No passkeys are registered for this account.');

  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: rows.map((r) => ({
      id: r.id,
      transports: r.transports ? (JSON.parse(r.transports) as AuthenticatorTransportFuture[]) : undefined,
    })),
    userVerification: 'preferred',
  });
  putChallenge(`auth:${user.id}`, options.challenge, user.id);
  return options;
}

export async function finishAuthentication(
  user: UserRow,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  const { challenge } = takeChallenge(`auth:${user.id}`);
  const row = db()
    .prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?')
    .get(response.id, user.id) as PasskeyRow | undefined;
  if (!row) throw badRequest('Unknown security key for this account.');

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    credential: {
      id: row.id,
      publicKey: new Uint8Array(row.public_key),
      counter: row.counter,
      transports: row.transports ? (JSON.parse(row.transports) as AuthenticatorTransportFuture[]) : undefined,
    },
    requireUserVerification: false,
  });

  if (!verification.verified) return false;

  // A counter that fails to advance suggests a cloned authenticator.
  const newCounter = verification.authenticationInfo.newCounter;
  if (row.counter > 0 && newCounter <= row.counter) {
    throw badRequest('Security key counter did not advance — refusing to sign in.');
  }
  db()
    .prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
    .run(newCounter, now(), row.id);
  return true;
}

export function deletePasskey(userId: string, passkeyId: string): void {
  const result = db()
    .prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?')
    .run(passkeyId, userId);
  if (result.changes === 0) throw notFound('No such passkey.');
}

/** Short-lived id tying a pending second factor to the password step. */
export function newChallengeId(): string {
  return newId(24);
}
