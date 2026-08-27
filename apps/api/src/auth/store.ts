import type { User, Role, SessionInfo, AuditEntry } from '@cloud/shared';
import { db } from '../db/index.js';
import { config } from '../config.js';
import {
  hashPassword, hashToken, generateToken, generateRecoveryCodes, hashRecoveryCode,
} from './passwords.js';
import { generateSecret } from './totp.js';
import { newId, now, conflict, notFound } from '../util/index.js';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  totp_secret: string | null;
  totp_enrolled: number;
  totp_last_step: number;
  created_at: number;
  last_login_at: number | null;
}

export function toUser(row: UserRow): User {
  const passkeyCount = (
    db().prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(row.id) as {
      n: number;
    }
  ).n;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    totpEnrolled: row.totp_enrolled === 1,
    passkeyCount,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/* ----------------------------------------------------------------- users */

export function findUserByUsername(username: string): UserRow | undefined {
  return db().prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | UserRow
    | undefined;
}

export function findUserById(id: string): UserRow | undefined {
  return db().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function listUsers(): User[] {
  const rows = db()
    .prepare('SELECT * FROM users ORDER BY created_at ASC')
    .all() as UserRow[];
  return rows.map(toUser);
}

export function userCount(): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export async function createUser(opts: {
  username: string;
  displayName: string;
  password: string;
  role: Role;
}): Promise<UserRow> {
  if (findUserByUsername(opts.username)) {
    throw conflict(`Username "${opts.username}" is already taken.`);
  }
  const id = newId();
  const passwordHash = await hashPassword(opts.password);
  // Every account gets a TOTP secret at creation; enrolment confirms it works.
  db()
    .prepare(
      `INSERT INTO users
         (id, username, display_name, password_hash, role, totp_secret, totp_enrolled, totp_last_step, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    )
    .run(id, opts.username, opts.displayName, passwordHash, opts.role, generateSecret(), now());
  return findUserById(id)!;
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  db().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}

export function markTotpEnrolled(userId: string, step: number): void {
  db()
    .prepare('UPDATE users SET totp_enrolled = 1, totp_last_step = ? WHERE id = ?')
    .run(step, userId);
}

/** Record the step a code consumed so the same code cannot be reused. */
export function consumeTotpStep(userId: string, step: number): void {
  db().prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
}

export function resetTotp(userId: string): string {
  const secret = generateSecret();
  db()
    .prepare('UPDATE users SET totp_secret = ?, totp_enrolled = 0, totp_last_step = 0 WHERE id = ?')
    .run(secret, userId);
  return secret;
}

export function deleteUser(userId: string): void {
  const user = findUserById(userId);
  if (!user) throw notFound('No such user.');
  if (user.role === 'owner') {
    const owners = (
      db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get() as {
        n: number;
      }
    ).n;
    if (owners <= 1) throw conflict('Cannot delete the last owner account.');
  }
  db().prepare('DELETE FROM users WHERE id = ?').run(userId);
}

export function touchLogin(userId: string): void {
  db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
}

/* -------------------------------------------------------- recovery codes */

export function issueRecoveryCodes(userId: string): string[] {
  const codes = generateRecoveryCodes();
  const conn = db();
  const replace = conn.transaction(() => {
    conn.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const insert = conn.prepare(
      'INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)',
    );
    for (const code of codes) insert.run(userId, hashRecoveryCode(code));
  });
  replace();
  return codes;
}

/** Consume a recovery code, returning true only if it was valid and unused. */
export function redeemRecoveryCode(userId: string, code: string): boolean {
  const hash = hashRecoveryCode(code);
  const result = db()
    .prepare(
      'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    )
    .run(now(), userId, hash);
  return result.changes === 1;
}

export function remainingRecoveryCodes(userId: string): number {
  return (
    db()
      .prepare(
        'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
      )
      .get(userId) as { n: number }
  ).n;
}

/* -------------------------------------------------------------- sessions */

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  stepped_up_at: number | null;
  ip: string;
  user_agent: string;
}

export function createSession(
  userId: string,
  ip: string,
  userAgent: string,
  steppedUp: boolean,
): { token: string; session: SessionRow } {
  const token = generateToken();
  const id = newId();
  const at = now();
  const expires = at + config.sessionTtlDays * 86_400_000;
  db()
    .prepare(
      `INSERT INTO sessions
         (id, token_hash, user_id, created_at, last_seen_at, expires_at, stepped_up_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, hashToken(token), userId, at, at, expires, steppedUp ? at : null, ip, userAgent.slice(0, 300));
  return { token, session: db().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow };
}

export function findSessionByToken(token: string): SessionRow | undefined {
  const row = db().prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
    | SessionRow
    | undefined;
  if (!row) return undefined;
  if (row.expires_at <= now()) {
    db().prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return undefined;
  }
  return row;
}

export function touchSession(sessionId: string, ip: string): void {
  db()
    .prepare('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id = ?')
    .run(now(), ip, sessionId);
}

export function markSteppedUp(sessionId: string): void {
  db().prepare('UPDATE sessions SET stepped_up_at = ? WHERE id = ?').run(now(), sessionId);
}

export function revokeSession(sessionId: string): void {
  db().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/** Used after a password change — every other device must log in again. */
export function revokeOtherSessions(userId: string, keepSessionId: string): number {
  return db()
    .prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?')
    .run(userId, keepSessionId).changes;
}

export function listSessions(userId: string, currentId: string): SessionInfo[] {
  const rows = db()
    .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
    .all(userId) as SessionRow[];
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    current: r.id === currentId,
  }));
}

export function pruneSessions(): number {
  return db().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes;
}

/* ----------------------------------------------------------------- audit */

export function audit(entry: {
  userId?: string | null;
  username?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  outcome: 'ok' | 'denied' | 'error';
  detail?: string | null;
}): void {
  db()
    .prepare(
      `INSERT INTO audit_log (at, user_id, username, action, target, ip, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now(),
      entry.userId ?? null,
      entry.username ?? null,
      entry.action,
      entry.target ?? null,
      entry.ip ?? null,
      entry.outcome,
      entry.detail ?? null,
    );
}

interface AuditRow {
  id: number;
  at: number;
  user_id: string | null;
  username: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  outcome: 'ok' | 'denied' | 'error';
  detail: string | null;
}

export function listAudit(limit = 200, before?: number): AuditEntry[] {
  const rows = before
    ? (db()
        .prepare('SELECT * FROM audit_log WHERE at < ? ORDER BY at DESC LIMIT ?')
        .all(before, limit) as AuditRow[])
    : (db().prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit) as AuditRow[]);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    userId: r.user_id,
    username: r.username,
    action: r.action,
    target: r.target,
    ip: r.ip,
    outcome: r.outcome,
    detail: r.detail,
  }));
}
