import { Cron } from 'croner';
import { spawn } from 'node:child_process';
import type { Job, JobRun, JobState } from '@cloud/shared';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { pausedJobs } from '../profiles/engine.js';
import { sweep } from '../storage/tiering.js';
import { notFound, conflict } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('jobs');

export interface JobDefinition {
  id: string;
  name: string;
  description: string;
  /** Standard 5-field cron, evaluated in the server's local timezone. */
  schedule: string;
  run: (ctx: JobContext) => Promise<string>;
}

export interface JobContext {
  log: (line: string) => void;
}

/** Output kept per run, so a chatty job cannot bloat the database. */
const MAX_OUTPUT_CHARS = 20_000;

const definitions = new Map<string, JobDefinition>();
const crons = new Map<string, Cron>();
const running = new Set<string>();

type Listener = (jobs: Job[]) => void;
const listeners = new Set<Listener>();

export function subscribeJobs(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  const snapshot = listJobs();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) {
      log.warn('listener threw', err);
    }
  }
}

/* ----------------------------------------------------------------- state */

interface StateRow {
  id: string;
  enabled: number;
  last_run_at: number | null;
  last_duration_ms: number | null;
  last_error: string | null;
}

function stateFor(id: string): StateRow {
  const row = db().prepare('SELECT * FROM job_state WHERE id = ?').get(id) as
    | StateRow
    | undefined;
  if (row) return row;
  db().prepare('INSERT INTO job_state (id, enabled) VALUES (?, 1)').run(id);
  return { id, enabled: 1, last_run_at: null, last_duration_ms: null, last_error: null };
}

export function listJobs(): Job[] {
  const paused = new Set(pausedJobs());
  return [...definitions.values()].map((def): Job => {
    const state = stateFor(def.id);
    const cron = crons.get(def.id);
    const isPaused = paused.has(def.id);

    let jobState: JobState = 'idle';
    if (running.has(def.id)) jobState = 'running';
    else if (state.enabled === 0) jobState = 'disabled';
    else if (state.last_error) jobState = 'failed';

    return {
      id: def.id,
      name: def.name,
      description: def.description,
      schedule: def.schedule,
      state: jobState,
      enabled: state.enabled === 1,
      lastRunAt: state.last_run_at,
      lastDurationMs: state.last_duration_ms,
      lastError: state.last_error,
      nextRunAt: cron?.nextRun()?.getTime() ?? null,
      pausedByProfile: isPaused,
    };
  });
}

export function listRuns(jobId: string, limit = 20): JobRun[] {
  return db()
    .prepare(
      'SELECT id, job_id AS jobId, started_at AS startedAt, finished_at AS finishedAt, ok, output FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?',
    )
    .all(jobId, Math.min(limit, 100)) as JobRun[];
}

export function setJobEnabled(id: string, enabled: boolean): void {
  if (!definitions.has(id)) throw notFound('No such job.');
  stateFor(id);
  db().prepare('UPDATE job_state SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  emit();
}

/* ------------------------------------------------------------- execution */

export async function runJob(id: string, trigger: 'schedule' | 'manual'): Promise<JobRun> {
  const definition = definitions.get(id);
  if (!definition) throw notFound('No such job.');
  if (running.has(id)) throw conflict('That job is already running.');

  const state = stateFor(id);
  if (trigger === 'schedule') {
    if (state.enabled === 0) {
      log.debug(`skipping "${id}" — disabled`);
      return blankRun(id);
    }
    // The active resource profile can pause heavy jobs, e.g. during Gaming.
    if (pausedJobs().includes(id)) {
      log.info(`skipping "${id}" — paused by the active profile`);
      return blankRun(id);
    }
  }

  running.add(id);
  emit();

  const startedAt = Date.now();
  const insert = db()
    .prepare('INSERT INTO job_runs (job_id, started_at, output) VALUES (?, ?, ?)')
    .run(id, startedAt, '');
  const runId = Number(insert.lastInsertRowid);

  const lines: string[] = [];
  const ctx: JobContext = {
    log: (line: string) => {
      lines.push(line);
      // Keep only the tail; a long rsync would otherwise fill memory.
      if (lines.length > 500) lines.splice(0, lines.length - 500);
    },
  };

  let ok = true;
  let error: string | null = null;

  try {
    const summary = await definition.run(ctx);
    if (summary) ctx.log(summary);
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
    ctx.log(`ERROR: ${error}`);
    log.error(`job "${id}" failed`, err);
  }

  const finishedAt = Date.now();
  const output = lines.join('\n').slice(-MAX_OUTPUT_CHARS);

  db()
    .prepare('UPDATE job_runs SET finished_at = ?, ok = ?, output = ? WHERE id = ?')
    .run(finishedAt, ok ? 1 : 0, output, runId);
  db()
    .prepare(
      'UPDATE job_state SET last_run_at = ?, last_duration_ms = ?, last_error = ? WHERE id = ?',
    )
    .run(finishedAt, finishedAt - startedAt, error, id);

  // Keep the run history bounded per job.
  db()
    .prepare(
      `DELETE FROM job_runs WHERE job_id = ? AND id NOT IN (
         SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 50
       )`,
    )
    .run(id, id);

  running.delete(id);
  emit();

  return {
    id: runId,
    jobId: id,
    startedAt,
    finishedAt,
    ok,
    output,
  };
}

function blankRun(jobId: string): JobRun {
  return { id: 0, jobId, startedAt: Date.now(), finishedAt: Date.now(), ok: true, output: 'skipped' };
}

/* ------------------------------------------------------------ definitions */

/** Run a shell command as a job step, capturing its output. */
export function runProcess(
  command: string,
  args: string[],
  ctx: JobContext,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Arguments are never passed through a shell.
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) ctx.log(line.trimEnd());
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export function register(definition: JobDefinition): void {
  definitions.set(definition.id, definition);
  stateFor(definition.id);
}

export function registerDefaults(): void {
  register({
    id: 'backup-nightly',
    name: 'Nightly backup',
    description:
      'Copies databases, container configuration and the dashboard state to the StorageBox.',
    schedule: '0 4 * * *',
    run: async (ctx) => {
      ctx.log('Starting nightly backup.');
      const source = config.dataDir;
      const stamp = new Date().toISOString().slice(0, 10);
      const destination = `${config.rclone.remote}:Backups/VPS/${stamp}`;
      await runProcess(
        config.rclone.binary,
        ['copy', source, destination, '--stats=10s', '--stats-one-line'],
        ctx,
      );
      return `Backed up ${source} to ${destination}.`;
    },
  });

  register({
    id: 'tier-sweep',
    name: 'Storage tiering sweep',
    description:
      'Moves cold files from the local HDD to the StorageBox when the HDD passes its target fill level.',
    schedule: '0 3 * * *',
    run: async (ctx) => {
      const result = await sweep();
      if (result.skipped) return `Nothing to do: ${result.skipped}.`;
      return `Queued ${result.moved} file(s), ${(result.bytes / 1024 ** 3).toFixed(1)} GiB.`;
    },
  });

  register({
    id: 'media-scan',
    name: 'Media library scan',
    description: 'Asks Jellyfin to look for newly added media.',
    schedule: '30 5 * * *',
    run: async (ctx) => {
      const { rescanLibraries } = await import('../services/jellyfin.js');
      await rescanLibraries();
      ctx.log('Requested a Jellyfin library refresh.');
      return 'Library scan requested.';
    },
  });

  register({
    id: 'minecraft-backup',
    name: 'Minecraft world backup',
    description: 'Flushes and copies the Minecraft world to the StorageBox.',
    schedule: '0 5 * * *',
    run: async (ctx) => {
      const { backup } = await import('../services/minecraft.js');
      const result = await backup();
      ctx.log(`Backup queued as transfer ${result.transferId}.`);
      return `World copied to ${result.destination}.`;
    },
  });

  register({
    id: 'db-maintenance',
    name: 'Database maintenance',
    description: 'Compacts the dashboard database and folds metrics into hourly rollups.',
    schedule: '15 4 * * 0',
    run: async (ctx) => {
      const { rollup } = await import('../metrics/history.js');
      const result = rollup();
      ctx.log(`Rolled up ${result.rolled} hours, pruned ${result.pruned} samples.`);
      db().pragma('wal_checkpoint(TRUNCATE)');
      db().exec('VACUUM');
      return 'Database compacted.';
    },
  });
}

/* ------------------------------------------------------------- lifecycle */

export function startScheduler(): void {
  for (const definition of definitions.values()) {
    if (crons.has(definition.id)) continue;
    try {
      const cron = new Cron(definition.schedule, { protect: true }, () => {
        void runJob(definition.id, 'schedule').catch((err) =>
          log.error(`scheduled run of "${definition.id}" failed`, err),
        );
      });
      crons.set(definition.id, cron);
    } catch (err) {
      log.error(`invalid schedule for job "${definition.id}": ${definition.schedule}`, err);
    }
  }
  log.info(`scheduled ${crons.size} jobs`);
}

export function stopScheduler(): void {
  for (const cron of crons.values()) cron.stop();
  crons.clear();
}
