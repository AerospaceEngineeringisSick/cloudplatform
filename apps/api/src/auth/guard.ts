import '@fastify/cookie';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Role } from '@cloud/shared';
import { config } from '../config.js';
import { unauthorized, forbidden } from '../util/index.js';
import {
  findSessionByToken, findUserById, touchSession, type SessionRow, type UserRow,
} from './store.js';

export const SESSION_COOKIE = '__Host-cloud_session';

/** Falls back to a plain name when not on HTTPS — `__Host-` requires secure. */
export function cookieName(): string {
  return config.origin.startsWith('https://') ? SESSION_COOKIE : 'cloud_session';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { user: UserRow; session: SessionRow };
  }
}

export function clientIp(req: FastifyRequest): string {
  return req.ip ?? '';
}

/**
 * Resolves the session cookie onto the request. Does not reject — routes
 * decide whether anonymous access is acceptable.
 */
export async function loadSession(req: FastifyRequest): Promise<void> {
  const token = req.cookies[cookieName()];
  if (!token) return;
  const session = findSessionByToken(token);
  if (!session) return;
  const user = findUserById(session.user_id);
  if (!user) return;
  req.auth = { user, session };
  touchSession(session.id, clientIp(req));
}

/** Rejects anonymous requests. Use as a Fastify preHandler. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.auth) throw unauthorized('Sign in to continue.');
}

const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function requireRole(minimum: Role) {
  return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.auth) throw unauthorized('Sign in to continue.');
    if (RANK[req.auth.user.role] < RANK[minimum]) {
      throw forbidden(`This action requires the ${minimum} role.`);
    }
  };
}

/**
 * Destructive actions demand a recent second factor, so a stolen session
 * cookie alone cannot wipe a disk or delete a user.
 */
export async function requireStepUp(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.auth) throw unauthorized('Sign in to continue.');
  if (!config.security.requireStepUp) return;
  const at = req.auth.session.stepped_up_at;
  const maxAge = config.security.stepUpWindowSec * 1000;
  if (!at || Date.now() - at > maxAge) {
    throw forbidden('Confirm your identity again to perform this action.');
  }
}
