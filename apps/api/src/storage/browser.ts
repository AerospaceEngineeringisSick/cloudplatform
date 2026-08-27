import { readdir, stat, lstat, mkdir, rm, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { DirListing, FileEntry, StorageTierSummary } from '@cloud/shared';
import { config } from '../config.js';
import { collector } from '../metrics/collector.js';
import { resolveReal, resolveLexical, parentOf, joinRelative, mountById } from './paths.js';
import { badRequest, conflict, notFound, mapLimit, withTimeout } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('storage');

/** A directory with more entries than this is truncated rather than streamed. */
const MAX_ENTRIES = 2000;

function modeString(mode: number, isDir: boolean): string {
  const bits = ['r', 'w', 'x'];
  let out = isDir ? 'd' : '-';
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let bit = 0; bit < 3; bit++) {
      out += mode & (1 << (shift + (2 - bit))) ? bits[bit] : '-';
    }
  }
  return out;
}

export async function listDirectory(
  mountId: string,
  relPath: string,
  opts: { countChildren?: boolean } = {},
): Promise<DirListing> {
  const target = await resolveReal(mountId, relPath);

  let stats;
  try {
    stats = await withTimeout(stat(target.absolute), 10_000, 'stat');
  } catch {
    throw notFound('That folder does not exist.');
  }
  if (!stats.isDirectory()) throw badRequest('That path is a file, not a folder.');

  const names = await withTimeout(readdir(target.absolute), 20_000, 'readdir');
  const truncated = names.length > MAX_ENTRIES;
  const slice = truncated ? names.slice(0, MAX_ENTRIES) : names;

  const entries = await mapLimit(slice, 16, async (name): Promise<FileEntry | null> => {
    const abs = join(target.absolute, name);
    try {
      // lstat, so a dangling symlink lists rather than throwing.
      const s = await lstat(abs);
      const isDir = s.isDirectory();
      let childCount: number | null = null;
      if (isDir && opts.countChildren) {
        try {
          childCount = (await readdir(abs)).length;
        } catch {
          childCount = null;
        }
      }
      return {
        name,
        path: joinRelativeSafe(target.relative, name),
        isDir,
        sizeBytes: isDir ? 0 : s.size,
        modifiedAt: s.mtimeMs,
        childCount,
        mode: modeString(s.mode, isDir),
      };
    } catch {
      return null;
    }
  });

  const usable = entries.filter((e): e is FileEntry => e !== null);
  // Folders first, then alphabetical — the ordering people expect.
  usable.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return {
    path: target.relative,
    tier: target.mount.tier,
    parent: parentOf(target.relative),
    entries: usable,
    truncated,
  };
}

function joinRelativeSafe(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export async function createFolder(mountId: string, relPath: string, name: string): Promise<void> {
  const parent = await resolveReal(mountId, relPath);
  const target = resolveLexical(mountId, joinRelative(parent.relative, name));
  try {
    await mkdir(target.absolute);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === 'EEXIST') throw conflict('Something with that name already exists.');
    throw err;
  }
}

export async function renameEntry(
  mountId: string,
  relPath: string,
  newName: string,
): Promise<void> {
  const source = await resolveReal(mountId, relPath);
  const parent = parentOf(source.relative) ?? '';
  const destination = resolveLexical(mountId, joinRelative(parent, newName));
  try {
    await rename(source.absolute, destination.absolute);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === 'EEXIST' || e.code === 'ENOTEMPTY') {
      throw conflict('Something with that name already exists.');
    }
    throw err;
  }
}

export async function deleteEntry(mountId: string, relPath: string): Promise<void> {
  const target = await resolveReal(mountId, relPath);
  // Deleting a whole mount root would be catastrophic and is never intended.
  if (target.relative === '') throw badRequest('Refusing to delete a storage root.');
  await rm(target.absolute, { recursive: true, force: false });
  log.info(`deleted ${target.mount.id}:/${target.relative}`);
}

export async function openDownload(mountId: string, relPath: string) {
  const target = await resolveReal(mountId, relPath);
  const s = await stat(target.absolute);
  if (!s.isFile()) throw badRequest('Only files can be downloaded.');
  return {
    stream: createReadStream(target.absolute),
    size: s.size,
    filename: target.relative.split('/').pop() ?? 'download',
  };
}

/** Recursive size of a directory, bounded so a huge tree cannot hang a request. */
export async function directorySize(
  mountId: string,
  relPath: string,
  budgetMs = 15_000,
): Promise<{ bytes: number; files: number; complete: boolean }> {
  const root = await resolveReal(mountId, relPath);
  const deadline = Date.now() + budgetMs;
  let bytes = 0;
  let files = 0;
  let complete = true;

  const walk = async (dir: string): Promise<void> => {
    if (Date.now() > deadline) {
      complete = false;
      return;
    }
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (Date.now() > deadline) {
        complete = false;
        return;
      }
      const abs = join(dir, name);
      try {
        const s = await lstat(abs);
        if (s.isDirectory()) await walk(abs);
        else if (s.isFile()) {
          bytes += s.size;
          files++;
        }
      } catch {
        continue;
      }
    }
  };

  await walk(root.absolute);
  return { bytes, files, complete };
}

/** Tier summaries come straight from the live collector snapshot. */
export function tierSummaries(): StorageTierSummary[] {
  const snapshot = collector.snapshot();
  return config.mounts.map((mount) => {
    const disk = snapshot?.disks.find((d) => d.id === mount.id);
    return {
      tier: mount.tier,
      label: mount.label,
      mountpoint: mount.mountpoint,
      totalBytes: disk?.totalBytes ?? 0,
      usedBytes: disk?.usedBytes ?? 0,
      freeBytes: disk?.freeBytes ?? 0,
      online: disk?.online ?? false,
    };
  });
}

export { mountById };
