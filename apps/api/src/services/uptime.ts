import { Socket } from 'node:net';
import { statfs } from 'node:fs/promises';
import type { UptimeCheck } from '@cloud/shared';
import { db } from '../db/index.js';
import { supervisor } from '../docker/supervisor.js';
import { newId, badRequest, notFound, withTimeout, mapLimit } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('uptime');

const CHECK_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 8000;
/** Bars on the dashboard cover 30 days. */
const HISTORY_DAYS = 30;

interface CheckRow {
  id: string;
  name: string;
  kind: 'http' | 'tcp' | 'container' | 'mount';
  target: string;
  enabled: number;
  created_at: number;
}

function dayKey(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- probing */

async function probeHttp(target: string): Promise<{ up: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      // A HEAD is enough to prove the service is answering.
      method: 'HEAD',
    });
    // Any non-5xx answer means something is alive and routing correctly.
    const up = response.status < 500;
    return {
      up,
      latencyMs: Date.now() - started,
      error: up ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      up: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

function probeTcp(target: string): Promise<{ up: boolean; latencyMs: number; error?: string }> {
  const [host, portRaw] = target.split(':');
  const port = Number(portRaw);
  if (!host || !Number.isFinite(port)) {
    return Promise.resolve({ up: false, latencyMs: 0, error: 'target must be host:port' });
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new Socket();
    let settled = false;
    const done = (up: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ up, latencyMs: Date.now() - started, error });
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on('timeout', () => done(false, 'timed out'));
    socket.on('error', (err) => done(false, err.message));
    socket.connect(port, host, () => done(true));
  });
}

async function probeContainer(serviceKey: string): Promise<{ up: boolean; latencyMs: number; error?: string }> {
  const container = supervisor.byServiceKey(serviceKey);
  if (!container) return { up: false, latencyMs: 0, error: 'not deployed' };
  const up = container.state === 'running' && container.health !== 'unhealthy';
  return { up, latencyMs: 0, error: up ? undefined : container.status };
}

async function probeMount(mountpoint: string): Promise<{ up: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    // A hung SFTP mount blocks here, which is exactly what we want to detect.
    const stats = await withTimeout(statfs(mountpoint), PROBE_TIMEOUT_MS, 'statfs');
    return { up: stats.blocks > 0, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      up: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'unavailable',
    };
  }
}

async function probe(check: CheckRow) {
  switch (check.kind) {
    case 'http':
      return probeHttp(check.target);
    case 'tcp':
      return probeTcp(check.target);
    case 'container':
      return probeContainer(check.target);
    case 'mount':
      return probeMount(check.target);
    default:
      return { up: false, latencyMs: 0, error: 'unknown check kind' };
  }
}

/* ---------------------------------------------------------------- store */

export function listChecks(): UptimeCheck[] {
  const rows = db().prepare('SELECT * FROM uptime_checks ORDER BY name ASC').all() as CheckRow[];

  return rows.map((row) => {
    const latest = db()
      .prepare(
        'SELECT at, up, latency_ms FROM uptime_results WHERE check_id = ? ORDER BY at DESC LIMIT 1',
      )
      .get(row.id) as { at: number; up: number; latency_ms: number | null } | undefined;

    const daily = db()
      .prepare(
        `SELECT day, up_count, total_count FROM uptime_daily
         WHERE check_id = ? AND day >= ? ORDER BY day ASC`,
      )
      .all(row.id, dayKey(Date.now() - HISTORY_DAYS * 86_400_000)) as {
      day: string;
      up_count: number;
      total_count: number;
    }[];

    const byDay = new Map(daily.map((d) => [d.day, d]));
    const history: (number | null)[] = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const key = dayKey(Date.now() - i * 86_400_000);
      const entry = byDay.get(key);
      history.push(entry && entry.total_count > 0 ? entry.up_count / entry.total_count : null);
    }

    const totals = daily.reduce(
      (acc, d) => ({ up: acc.up + d.up_count, total: acc.total + d.total_count }),
      { up: 0, total: 0 },
    );

    return {
      id: row.id,
      name: row.name,
      target: row.target,
      kind: row.kind,
      up: latest?.up === 1,
      lastCheckedAt: latest?.at ?? null,
      latencyMs: latest?.latency_ms ?? null,
      uptime30d: totals.total > 0 ? totals.up / totals.total : 0,
      history,
      enabled: row.enabled === 1,
    };
  });
}

export function createCheck(input: {
  name: string;
  kind: UptimeCheck['kind'];
  target: string;
}): UptimeCheck {
  const name = input.name?.trim();
  if (!name || name.length > 80) throw badRequest('Give the check a name of 1–80 characters.');
  if (!['http', 'tcp', 'container', 'mount'].includes(input.kind)) {
    throw badRequest('Unknown check kind.');
  }
  const target = input.target?.trim();
  if (!target || target.length > 300) throw badRequest('Give the check a target.');

  if (input.kind === 'http') {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw badRequest('That is not a valid URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw badRequest('Only http and https URLs can be monitored.');
    }
  }

  const id = newId(8);
  db()
    .prepare(
      'INSERT INTO uptime_checks (id, name, kind, target, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    )
    .run(id, name, input.kind, target, Date.now());

  return listChecks().find((c) => c.id === id)!;
}

export function deleteCheck(id: string): void {
  const result = db().prepare('DELETE FROM uptime_checks WHERE id = ?').run(id);
  if (result.changes === 0) throw notFound('No such check.');
}

export function setCheckEnabled(id: string, enabled: boolean): void {
  const result = db()
    .prepare('UPDATE uptime_checks SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id);
  if (result.changes === 0) throw notFound('No such check.');
}

function record(checkId: string, up: boolean, latencyMs: number, error?: string): void {
  const at = Date.now();
  const conn = db();
  const tx = conn.transaction(() => {
    conn
      .prepare(
        'INSERT OR REPLACE INTO uptime_results (check_id, at, up, latency_ms, error) VALUES (?, ?, ?, ?, ?)',
      )
      .run(checkId, at, up ? 1 : 0, latencyMs, error ?? null);
    conn
      .prepare(
        `INSERT INTO uptime_daily (check_id, day, up_count, total_count) VALUES (?, ?, ?, 1)
         ON CONFLICT(check_id, day) DO UPDATE SET
           up_count = up_count + excluded.up_count,
           total_count = total_count + 1`,
      )
      .run(checkId, dayKey(at), up ? 1 : 0);
  });
  tx();
}

/* -------------------------------------------------------------- monitor */

type Listener = (checks: UptimeCheck[]) => void;

class Monitor {
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<Listener>();

  start(): void {
    if (this.timer) return;
    void this.runAll();
    this.timer = setInterval(() => void this.runAll(), CHECK_INTERVAL_MS);
    this.timer.unref();
    log.info(`monitoring every ${CHECK_INTERVAL_MS / 1000}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async runAll(): Promise<void> {
    try {
      const rows = db()
        .prepare('SELECT * FROM uptime_checks WHERE enabled = 1')
        .all() as CheckRow[];

      await mapLimit(rows, 5, async (row) => {
        try {
          const result = await probe(row);
          record(row.id, result.up, result.latencyMs, result.error);
        } catch (err) {
          log.warn(`check "${row.name}" threw`, err);
          record(row.id, false, 0, err instanceof Error ? err.message : 'error');
        }
      });

      this.prune();

      const checks = listChecks();
      for (const fn of this.listeners) {
        try {
          fn(checks);
        } catch (err) {
          log.warn('listener threw', err);
        }
      }
    } catch (err) {
      log.error('monitor pass failed', err);
    }
  }

  /** Raw results are only needed for recent detail; dailies carry the history. */
  private prune(): void {
    db()
      .prepare('DELETE FROM uptime_results WHERE at < ?')
      .run(Date.now() - 3 * 86_400_000);
    db()
      .prepare('DELETE FROM uptime_daily WHERE day < ?')
      .run(dayKey(Date.now() - 400 * 86_400_000));
  }
}

export const monitor = new Monitor();

/** Seeds the checks that make sense for this platform on first run. */
export function seedDefaultChecks(): void {
  const count = (db().prepare('SELECT COUNT(*) AS n FROM uptime_checks').get() as { n: number }).n;
  if (count > 0) return;

  const defaults: { name: string; kind: UptimeCheck['kind']; target: string }[] = [
    { name: 'Jellyfin', kind: 'container', target: 'jellyfin' },
    { name: 'Immich', kind: 'container', target: 'immich' },
    { name: 'Syncthing', kind: 'container', target: 'syncthing' },
    { name: 'Database', kind: 'container', target: 'database' },
    { name: 'Reverse proxy', kind: 'container', target: 'proxy' },
    { name: 'StorageBox mount', kind: 'mount', target: '/mnt/storagebox' },
    { name: 'Local HDD', kind: 'mount', target: '/mnt/hdd' },
  ];

  for (const check of defaults) {
    try {
      createCheck(check);
    } catch (err) {
      log.warn(`could not seed check "${check.name}"`, err);
    }
  }
  log.info(`seeded ${defaults.length} default uptime checks`);
}
