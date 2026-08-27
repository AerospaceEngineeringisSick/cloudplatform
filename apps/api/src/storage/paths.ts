import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { DiskTier } from '@cloud/shared';
import { config, type MountConfig } from '../config.js';
import { badRequest, forbidden } from '../util/index.js';

/**
 * Every path the file browser touches goes through here. The rule is simple:
 * a request names a mount and a path *relative to that mount*, and the result
 * must still be inside that mount after symlinks are resolved.
 */

export interface ResolvedPath {
  mount: MountConfig;
  /** Absolute path on disk. */
  absolute: string;
  /** Path relative to the mount root, always using forward slashes. */
  relative: string;
}

export function mountById(id: string): MountConfig {
  const mount = config.mounts.find((m) => m.id === id);
  if (!mount) throw badRequest(`Unknown storage mount "${id}".`);
  return mount;
}

export function mountByTier(tier: DiskTier): MountConfig {
  const mount = config.mounts.find((m) => m.tier === tier);
  if (!mount) throw badRequest(`No mount configured for tier "${tier}".`);
  return mount;
}

/** Reject the obvious attacks before touching the filesystem at all. */
function assertSaneInput(relPath: string): void {
  if (relPath.includes('\0')) throw badRequest('Path contains a null byte.');
  if (relPath.length > 4096) throw badRequest('Path is too long.');
  // Absolute paths would escape the mount join entirely.
  if (isAbsolute(relPath)) throw badRequest('Path must be relative to the mount.');
}

/**
 * Resolve without following symlinks. Used for paths that may not exist yet
 * (a copy destination), where realpath would throw.
 */
export function resolveLexical(mountId: string, relPath: string): ResolvedPath {
  const mount = mountById(mountId);
  assertSaneInput(relPath);

  const root = resolve(mount.mountpoint);
  const absolute = resolve(root, relPath);

  // `resolve` collapses `..`, so this catches traversal after normalisation.
  if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw forbidden('That path is outside the storage mount.');
  }

  return {
    mount,
    absolute,
    relative: normaliseRelative(relative(root, absolute)),
  };
}

/**
 * Resolve *and* follow symlinks, so a link pointing at /etc cannot be used to
 * read outside the mount. Use this for anything that already exists.
 */
export async function resolveReal(mountId: string, relPath: string): Promise<ResolvedPath> {
  const lexical = resolveLexical(mountId, relPath);
  const root = resolve(lexical.mount.mountpoint);

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw badRequest(`Storage mount "${mountId}" is not available.`);
  }
  try {
    realTarget = await realpath(lexical.absolute);
  } catch {
    // Does not exist yet — the lexical check already proved it is in-bounds.
    return lexical;
  }

  if (
    realTarget !== realRoot &&
    !realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
  ) {
    throw forbidden('That path resolves outside the storage mount.');
  }

  return {
    mount: lexical.mount,
    absolute: realTarget,
    relative: normaliseRelative(relative(realRoot, realTarget)),
  };
}

function normaliseRelative(value: string): string {
  const cleaned = value.split(sep).filter(Boolean).join('/');
  return cleaned;
}

/** Parent directory within the mount, or null at the root. */
export function parentOf(relPath: string): string | null {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return parts.slice(0, -1).join('/');
}

/** Reject names that would break out of a directory or confuse the shell. */
export function assertSafeName(name: string): string {
  if (!name || name === '.' || name === '..') throw badRequest('Invalid name.');
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw badRequest('A name cannot contain slashes or null bytes.');
  }
  if (name.length > 255) throw badRequest('That name is too long.');
  return name;
}

export function joinRelative(base: string, name: string): string {
  assertSafeName(name);
  return base ? `${base}/${name}` : name;
}

export { join };
