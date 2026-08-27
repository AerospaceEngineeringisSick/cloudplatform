import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { Transfer, TransferState } from '@cloud/shared';
import { config } from '../config.js';
import { resolveReal, resolveLexical, mountById } from './paths.js';
import { newId, badRequest, notFound, conflict } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('transfers');

/**
 * Moving data between tiers is delegated to rclone, which already handles
 * resume, checksums, bandwidth limits and remote backends far better than
 * anything hand-rolled. We supervise the process and parse its progress.
 */

const transfers = new Map<string, Transfer>();
const processes = new Map<string, ReturnType<typeof spawn>>();

/** Completed transfers are kept briefly so the UI can show the outcome. */
const KEEP_FINISHED_MS = 10 * 60_000;
const MAX_CONCURRENT = 2;

export function listTransfers(): Transfer[] {
  return [...transfers.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getTransfer(id: string): Transfer {
  const t = transfers.get(id);
  if (!t) throw notFound('No such transfer.');
  return t;
}

function activeCount(): number {
  return [...transfers.values()].filter(
    (t) => t.state === 'running' || t.state === 'queued',
  ).length;
}

export interface StartTransferOptions {
  kind: 'move' | 'copy';
  sourceMount: string;
  sourcePath: string;
  destMount: string;
  destPath: string;
}

export async function startTransfer(opts: StartTransferOptions): Promise<Transfer> {
  if (activeCount() >= MAX_CONCURRENT) {
    throw conflict(`At most ${MAX_CONCURRENT} transfers can run at once.`);
  }

  const source = await resolveReal(opts.sourceMount, opts.sourcePath);
  // The destination may not exist yet, so it is resolved lexically.
  const destination = resolveLexical(opts.destMount, opts.destPath);

  if (source.relative === '') throw badRequest('Refusing to move a whole storage root.');

  // Moving a directory into itself would recurse forever.
  if (
    source.mount.id === destination.mount.id &&
    (destination.absolute === source.absolute ||
      destination.absolute.startsWith(`${source.absolute}/`))
  ) {
    throw badRequest('Cannot move a folder into itself.');
  }

  let bytesTotal = 0;
  try {
    const s = await stat(source.absolute);
    bytesTotal = s.isFile() ? s.size : 0;
  } catch {
    throw notFound('The source no longer exists.');
  }

  const id = newId(8);
  const transfer: Transfer = {
    id,
    kind: opts.kind,
    source: `${source.mount.label}:/${source.relative}`,
    destination: `${destination.mount.label}:/${destination.relative}`,
    state: 'queued',
    bytesTotal,
    bytesDone: 0,
    speed: 0,
    etaSec: null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  transfers.set(id, transfer);

  run(id, opts.kind, source.absolute, destination.absolute);
  return transfer;
}

function buildArgs(kind: 'move' | 'copy', source: string, dest: string): string[] {
  const args = [
    kind,
    source,
    dest,
    // Machine-readable progress on stdout.
    '--stats=1s',
    '--stats-one-line',
    '--use-json-log',
    '--log-level=INFO',
    `--transfers=${config.rclone.transfers}`,
    // Never clobber a newer file at the destination by accident.
    '--update',
  ];
  if (config.rclone.bandwidthLimit) args.push(`--bwlimit=${config.rclone.bandwidthLimit}`);
  if (kind === 'move') args.push('--delete-empty-src-dirs');
  return args;
}

function run(id: string, kind: 'move' | 'copy', source: string, dest: string): void {
  const transfer = transfers.get(id);
  if (!transfer) return;

  const args = buildArgs(kind, source, dest);
  const env = { ...process.env };
  if (config.rclone.configPath) env.RCLONE_CONFIG = config.rclone.configPath;

  log.info(`${kind} ${source} -> ${dest}`);

  // Arguments are passed as an array, never through a shell, so a filename
  // containing shell metacharacters cannot become a command.
  const child = spawn(config.rclone.binary, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.set(id, child);
  transfer.state = 'running';

  let stderrTail = '';

  child.stdout?.on('data', (chunk: Buffer) => parseProgress(id, chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    parseProgress(id, text);
    stderrTail = (stderrTail + text).slice(-4000);
  });

  child.on('error', (err) => {
    finish(id, 'failed', err.message);
  });

  child.on('close', (code, signal) => {
    processes.delete(id);
    const current = transfers.get(id);
    if (!current) return;
    if (current.state === 'cancelled') {
      finish(id, 'cancelled', null);
      return;
    }
    if (code === 0) {
      current.bytesDone = current.bytesTotal || current.bytesDone;
      finish(id, 'done', null);
    } else {
      finish(id, 'failed', lastMeaningfulLine(stderrTail) || `rclone exited with ${signal ?? code}`);
    }
  });
}

/** rclone's JSON log lines carry transferred bytes, speed and ETA. */
function parseProgress(id: string, text: string): void {
  const transfer = transfers.get(id);
  if (!transfer) return;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const entry = JSON.parse(trimmed) as {
        stats?: { bytes?: number; totalBytes?: number; speed?: number; eta?: number | null };
      };
      const stats = entry.stats;
      if (!stats) continue;
      if (typeof stats.bytes === 'number') transfer.bytesDone = stats.bytes;
      if (typeof stats.totalBytes === 'number' && stats.totalBytes > 0) {
        transfer.bytesTotal = stats.totalBytes;
      }
      if (typeof stats.speed === 'number') transfer.speed = stats.speed;
      transfer.etaSec = typeof stats.eta === 'number' ? stats.eta : null;
    } catch {
      continue;
    }
  }
}

function lastMeaningfulLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('{'));
  return lines.length ? lines[lines.length - 1]! : null;
}

function finish(id: string, state: TransferState, error: string | null): void {
  const transfer = transfers.get(id);
  if (!transfer) return;
  transfer.state = state;
  transfer.error = error;
  transfer.finishedAt = Date.now();
  transfer.speed = 0;
  transfer.etaSec = null;
  log.info(`transfer ${id} ${state}${error ? `: ${error}` : ''}`);

  setTimeout(() => transfers.delete(id), KEEP_FINISHED_MS).unref();
}

export function cancelTransfer(id: string): void {
  const transfer = transfers.get(id);
  if (!transfer) throw notFound('No such transfer.');
  if (transfer.state !== 'running' && transfer.state !== 'queued') {
    throw conflict('That transfer is no longer running.');
  }
  transfer.state = 'cancelled';
  const child = processes.get(id);
  // SIGINT lets rclone finish the current file and exit cleanly.
  child?.kill('SIGINT');
}

/** Confirms rclone is installed, so the UI can explain rather than fail late. */
export async function rcloneVersion(): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(config.rclone.binary, ['version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.on('error', () => resolvePromise(null));
    child.on('close', (code) => {
      if (code !== 0) return resolvePromise(null);
      resolvePromise(out.split('\n')[0]?.trim() ?? null);
    });
  });
}

export { mountById };
