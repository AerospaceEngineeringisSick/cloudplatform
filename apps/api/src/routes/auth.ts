import '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { LoginChallenge, Role } from '@cloud/shared';
import { config } from '../config.js';
import { badRequest, unauthorized, forbidden, notFound, newId } from '../util/index.js';
import { verifyPassword, checkPasswordPolicy } from '../auth/passwords.js';
import { verifyCode, otpauthUri, stepFor } from '../auth/totp.js';
import {
  findUserByUsername, findUserById, createUser, listUsers, userCount, toUser,
  markTotpEnrolled, consumeTotpStep, resetTotp, setPassword, deleteUser, touchLogin,
  createSession, revokeSession, revokeOtherSessions, listSessions, markSteppedUp,
  issueRecoveryCodes, redeemRecoveryCode, remainingRecoveryCodes, audit, listAudit,
  type UserRow,
} from '../auth/store.js';
import { assertNotThrottled, recordAttempt, clearAttempts, rateLimit } from '../auth/ratelimit.js';
import {
  startRegistration, finishRegistration, startAuthentication, finishAuthentication,
  listPasskeys, deletePasskey,
} from '../auth/webauthn.js';
import { cookieName, requireAuth, requireRole, requireStepUp, clientIp } from '../auth/guard.js';

/**
 * Pending second-factor challenges. A password check alone never issues a
 * session — it issues one of these, which expires quickly.
 */
const pending = new Map<string, { userId: string; expires: number; ip: string }>();
const PENDING_TTL_MS = 300_000;

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of pending) if (v.expires < t) pending.delete(k);
}, 30_000).unref();

function cookieOptions() {
  const secure = config.origin.startsWith('https://');
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: config.sessionTtlDays * 86_400,
  };
}

function body<T>(req: FastifyRequest): T {
  if (!req.body || typeof req.body !== 'object') throw badRequest('Expected a JSON body.');
  return req.body as T;
}

function str(value: unknown, field: string, max = 300): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"${field}" is required.`);
  }
  if (value.length > max) throw badRequest(`"${field}" is too long.`);
  return value.trim();
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------- first-run bootstrap */

  app.get('/api/auth/setup-state', async () => ({ needsSetup: userCount() === 0 }));

  /**
   * Creates the first owner account. Guarded by the user count rather than a
   * token: once one account exists this route is permanently closed.
   */
  app.post('/api/auth/setup', async (req, reply) => {
    if (userCount() > 0) throw forbidden('Setup has already been completed.');
    rateLimit(`setup:${clientIp(req)}`, 5, 60_000);

    const b = body<{ username: string; displayName: string; password: string }>(req);
    const username = str(b.username, 'username', 40);
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
      throw badRequest('Username may use letters, digits, dot, underscore and hyphen (3–40).');
    }
    const password = str(b.password, 'password', 200);
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) throw badRequest(policy.problems.join(' '));

    const user = await createUser({
      username,
      displayName: str(b.displayName, 'displayName', 80),
      password,
      role: 'owner',
    });
    audit({ userId: user.id, username, action: 'auth.setup', outcome: 'ok', ip: clientIp(req) });

    // Sign them straight in so they can finish TOTP enrolment, which is
    // mandatory before anything else in the platform unlocks.
    const { token } = createSession(user.id, clientIp(req), req.headers['user-agent'] ?? '', true);
    reply.setCookie(cookieName(), token, cookieOptions());
    return { user: toUser(user), mustEnrollTotp: true };
  });

  /* ------------------------------------------------------------- login */

  app.post('/api/auth/login', async (req, reply): Promise<LoginChallenge> => {
    const b = body<{ username: string; password: string }>(req);
    const username = str(b.username, 'username', 40);
    const password = str(b.password, 'password', 200);
    const ip = clientIp(req);

    // Throttle the account and the address independently.
    assertNotThrottled(`user:${username.toLowerCase()}`);
    assertNotThrottled(`ip:${ip}`);

    const user = findUserByUsername(username);
    const ok = user ? await verifyPassword(user.password_hash, password) : false;

    if (!user || !ok) {
      recordAttempt(`user:${username.toLowerCase()}`, false);
      recordAttempt(`ip:${ip}`, false);
      audit({ username, action: 'auth.login', outcome: 'denied', ip, detail: 'bad credentials' });
      // Identical message whether the account exists or not.
      throw unauthorized('Incorrect username or password.');
    }

    clearAttempts(`user:${username.toLowerCase()}`);

    // An account without TOTP has not finished enrolling. Let it in only far
    // enough to complete enrolment.
    if (!user.totp_enrolled) {
      const { token } = createSession(user.id, ip, req.headers['user-agent'] ?? '', true);
      reply.setCookie(cookieName(), token, cookieOptions());
      audit({ userId: user.id, username, action: 'auth.login', outcome: 'ok', ip, detail: 'enrolment pending' });
      return { stage: 'complete', user: toUser(user) };
    }

    const challengeId = newId(24);
    pending.set(challengeId, { userId: user.id, expires: Date.now() + PENDING_TTL_MS, ip });
    return { stage: 'totp', challengeId };
  });

  /** Second leg: TOTP, a passkey, or a recovery code. */
  app.post('/api/auth/login/verify', async (req, reply) => {
    const b = body<{ challengeId: string; code?: string; recoveryCode?: string }>(req);
    const challengeId = str(b.challengeId, 'challengeId', 64);
    const ip = clientIp(req);
    assertNotThrottled(`ip:${ip}`);

    const entry = pending.get(challengeId);
    if (!entry || entry.expires < Date.now()) {
      pending.delete(challengeId);
      throw unauthorized('That sign-in attempt expired. Start again.');
    }
    const user = findUserById(entry.userId);
    if (!user || !user.totp_secret) throw unauthorized('Sign-in failed.');

    let verified = false;
    let method = '';

    if (b.recoveryCode) {
      verified = redeemRecoveryCode(user.id, str(b.recoveryCode, 'recoveryCode', 40));
      method = 'recovery-code';
    } else if (b.code) {
      const result = verifyCode(user.totp_secret, str(b.code, 'code', 10), user.totp_last_step);
      verified = result.valid;
      if (verified && result.step !== null) consumeTotpStep(user.id, result.step);
      method = 'totp';
    } else {
      throw badRequest('Provide a code or a recovery code.');
    }

    if (!verified) {
      recordAttempt(`ip:${ip}`, false);
      recordAttempt(`user:${user.username.toLowerCase()}`, false);
      audit({ userId: user.id, username: user.username, action: 'auth.2fa', outcome: 'denied', ip, detail: method });
      throw unauthorized('That code is not valid.');
    }

    pending.delete(challengeId);
    clearAttempts(`ip:${ip}`);
    clearAttempts(`user:${user.username.toLowerCase()}`);
    touchLogin(user.id);

    const { token } = createSession(user.id, ip, req.headers['user-agent'] ?? '', true);
    reply.setCookie(cookieName(), token, cookieOptions());
    audit({ userId: user.id, username: user.username, action: 'auth.login', outcome: 'ok', ip, detail: method });
    return { user: toUser(user), recoveryCodesRemaining: remainingRecoveryCodes(user.id) };
  });

  /* ----------------------------------------------------- passkey login */

  app.post('/api/auth/login/passkey/options', async (req) => {
    const b = body<{ challengeId: string }>(req);
    const entry = pending.get(str(b.challengeId, 'challengeId', 64));
    if (!entry || entry.expires < Date.now()) throw unauthorized('That sign-in attempt expired.');
    const user = findUserById(entry.userId);
    if (!user) throw unauthorized('Sign-in failed.');
    return startAuthentication(user);
  });

  app.post('/api/auth/login/passkey/verify', async (req, reply) => {
    const b = body<{ challengeId: string; response: never }>(req);
    const challengeId = str(b.challengeId, 'challengeId', 64);
    const entry = pending.get(challengeId);
    if (!entry || entry.expires < Date.now()) throw unauthorized('That sign-in attempt expired.');
    const user = findUserById(entry.userId);
    if (!user) throw unauthorized('Sign-in failed.');
    const ip = clientIp(req);

    const ok = await finishAuthentication(user, b.response);
    if (!ok) {
      recordAttempt(`ip:${ip}`, false);
      audit({ userId: user.id, username: user.username, action: 'auth.2fa', outcome: 'denied', ip, detail: 'passkey' });
      throw unauthorized('That security key was not accepted.');
    }
    pending.delete(challengeId);
    clearAttempts(`ip:${ip}`);
    touchLogin(user.id);
    const { token } = createSession(user.id, ip, req.headers['user-agent'] ?? '', true);
    reply.setCookie(cookieName(), token, cookieOptions());
    audit({ userId: user.id, username: user.username, action: 'auth.login', outcome: 'ok', ip, detail: 'passkey' });
    return { user: toUser(user) };
  });

  /* ---------------------------------------------------------- session */

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const { user, session } = req.auth!;
    return {
      user: toUser(user),
      mustEnrollTotp: user.totp_enrolled === 0,
      steppedUp:
        session.stepped_up_at !== null &&
        Date.now() - session.stepped_up_at <= config.security.stepUpWindowSec * 1000,
      recoveryCodesRemaining: remainingRecoveryCodes(user.id),
    };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const { user, session } = req.auth!;
    revokeSession(session.id);
    reply.clearCookie(cookieName(), { path: '/' });
    audit({ userId: user.id, username: user.username, action: 'auth.logout', outcome: 'ok', ip: clientIp(req) });
    return { ok: true };
  });

  /** Re-confirm identity to unlock destructive actions for a short window. */
  app.post('/api/auth/step-up', { preHandler: requireAuth }, async (req) => {
    const { user, session } = req.auth!;
    const b = body<{ code: string }>(req);
    if (!user.totp_secret) throw badRequest('No second factor is configured.');
    const result = verifyCode(user.totp_secret, str(b.code, 'code', 10), user.totp_last_step);
    if (!result.valid) {
      audit({ userId: user.id, username: user.username, action: 'auth.stepup', outcome: 'denied', ip: clientIp(req) });
      throw unauthorized('That code is not valid.');
    }
    if (result.step !== null) consumeTotpStep(user.id, result.step);
    markSteppedUp(session.id);
    audit({ userId: user.id, username: user.username, action: 'auth.stepup', outcome: 'ok', ip: clientIp(req) });
    return { ok: true, until: Date.now() + config.security.stepUpWindowSec * 1000 };
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const { user, session } = req.auth!;
    return listSessions(user.id, session.id);
  });

  app.delete('/api/auth/sessions/:id', { preHandler: requireAuth }, async (req) => {
    const { user, session } = req.auth!;
    const id = (req.params as { id: string }).id;
    const owned = listSessions(user.id, session.id).some((s) => s.id === id);
    if (!owned) throw notFound('No such session.');
    revokeSession(id);
    audit({ userId: user.id, username: user.username, action: 'auth.session.revoke', target: id, outcome: 'ok', ip: clientIp(req) });
    return { ok: true };
  });

  /* -------------------------------------------------------- TOTP setup */

  app.post('/api/auth/totp/begin', { preHandler: requireAuth }, async (req) => {
    const { user } = req.auth!;
    if (user.totp_enrolled) throw badRequest('Two-factor authentication is already enabled.');
    if (!user.totp_secret) throw badRequest('No secret available — reset two-factor first.');
    const uri = otpauthUri(user.totp_secret, user.username, config.rpName);
    return {
      secret: user.totp_secret,
      uri,
      qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }),
    };
  });

  app.post('/api/auth/totp/confirm', { preHandler: requireAuth }, async (req) => {
    const { user } = req.auth!;
    if (user.totp_enrolled) throw badRequest('Two-factor authentication is already enabled.');
    if (!user.totp_secret) throw badRequest('No secret available.');
    const b = body<{ code: string }>(req);
    const result = verifyCode(user.totp_secret, str(b.code, 'code', 10), user.totp_last_step);
    if (!result.valid) throw badRequest('That code did not match. Check your authenticator clock.');
    markTotpEnrolled(user.id, result.step ?? stepFor());
    const codes = issueRecoveryCodes(user.id);
    audit({ userId: user.id, username: user.username, action: 'auth.totp.enroll', outcome: 'ok', ip: clientIp(req) });
    // Shown exactly once.
    return { ok: true, recoveryCodes: codes };
  });

  app.post(
    '/api/auth/totp/reset',
    { preHandler: [requireAuth, requireStepUp] },
    async (req) => {
      const { user } = req.auth!;
      const secret = resetTotp(user.id);
      const uri = otpauthUri(secret, user.username, config.rpName);
      audit({ userId: user.id, username: user.username, action: 'auth.totp.reset', outcome: 'ok', ip: clientIp(req) });
      return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) };
    },
  );

  app.post(
    '/api/auth/recovery-codes',
    { preHandler: [requireAuth, requireStepUp] },
    async (req) => {
      const { user } = req.auth!;
      audit({ userId: user.id, username: user.username, action: 'auth.recovery.regenerate', outcome: 'ok', ip: clientIp(req) });
      return { codes: issueRecoveryCodes(user.id) };
    },
  );

  /* ------------------------------------------------------------ passkeys */

  app.get('/api/auth/passkeys', { preHandler: requireAuth }, async (req) =>
    listPasskeys(req.auth!.user.id),
  );

  app.post('/api/auth/passkeys/begin', { preHandler: requireAuth }, async (req) =>
    startRegistration(req.auth!.user),
  );

  app.post('/api/auth/passkeys/finish', { preHandler: requireAuth }, async (req) => {
    const { user } = req.auth!;
    const b = body<{ response: never; label: string }>(req);
    await finishRegistration(user, b.response, typeof b.label === 'string' ? b.label : 'Security key');
    audit({ userId: user.id, username: user.username, action: 'auth.passkey.add', outcome: 'ok', ip: clientIp(req) });
    return { ok: true, passkeys: listPasskeys(user.id) };
  });

  app.delete(
    '/api/auth/passkeys/:id',
    { preHandler: [requireAuth, requireStepUp] },
    async (req) => {
      const { user } = req.auth!;
      deletePasskey(user.id, (req.params as { id: string }).id);
      audit({ userId: user.id, username: user.username, action: 'auth.passkey.remove', outcome: 'ok', ip: clientIp(req) });
      return { ok: true, passkeys: listPasskeys(user.id) };
    },
  );

  /* ------------------------------------------------------ password change */

  app.post('/api/auth/password', { preHandler: requireAuth }, async (req) => {
    const { user, session } = req.auth!;
    const b = body<{ current: string; next: string }>(req);
    const ok = await verifyPassword(user.password_hash, str(b.current, 'current', 200));
    if (!ok) {
      audit({ userId: user.id, username: user.username, action: 'auth.password.change', outcome: 'denied', ip: clientIp(req) });
      throw unauthorized('Your current password is not correct.');
    }
    const next = str(b.next, 'next', 200);
    const policy = checkPasswordPolicy(next);
    if (!policy.ok) throw badRequest(policy.problems.join(' '));
    await setPassword(user.id, next);
    const revoked = revokeOtherSessions(user.id, session.id);
    audit({ userId: user.id, username: user.username, action: 'auth.password.change', outcome: 'ok', ip: clientIp(req), detail: `${revoked} sessions revoked` });
    return { ok: true, otherSessionsRevoked: revoked };
  });

  /* ------------------------------------------------------ user management */

  app.get('/api/users', { preHandler: requireRole('admin') }, async () => listUsers());

  app.post(
    '/api/users',
    { preHandler: [requireRole('owner'), requireStepUp] },
    async (req) => {
      const b = body<{ username: string; displayName: string; password: string; role: Role }>(req);
      const username = str(b.username, 'username', 40);
      if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
        throw badRequest('Username may use letters, digits, dot, underscore and hyphen (3–40).');
      }
      const password = str(b.password, 'password', 200);
      const policy = checkPasswordPolicy(password);
      if (!policy.ok) throw badRequest(policy.problems.join(' '));
      const role: Role = b.role === 'admin' || b.role === 'member' ? b.role : 'member';

      const created = await createUser({
        username,
        displayName: str(b.displayName, 'displayName', 80),
        password,
        role,
      });
      audit({ userId: req.auth!.user.id, username: req.auth!.user.username, action: 'user.create', target: username, outcome: 'ok', ip: clientIp(req) });
      return toUser(created);
    },
  );

  app.delete(
    '/api/users/:id',
    { preHandler: [requireRole('owner'), requireStepUp] },
    async (req) => {
      const id = (req.params as { id: string }).id;
      if (id === req.auth!.user.id) throw badRequest('You cannot delete your own account.');
      const target: UserRow | undefined = findUserById(id);
      if (!target) throw notFound('No such user.');
      deleteUser(id);
      audit({ userId: req.auth!.user.id, username: req.auth!.user.username, action: 'user.delete', target: target.username, outcome: 'ok', ip: clientIp(req) });
      return { ok: true };
    },
  );

  /* ------------------------------------------------------------- audit log */

  app.get('/api/audit', { preHandler: requireRole('admin') }, async (req) => {
    const q = req.query as { limit?: string; before?: string };
    const limit = Math.min(Number(q.limit ?? 200) || 200, 1000);
    const before = q.before ? Number(q.before) : undefined;
    return listAudit(limit, Number.isFinite(before) ? before : undefined);
  });
}
