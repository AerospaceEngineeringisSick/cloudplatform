import type { HistoryMetric, HistoryRange, HistorySeries, SeriesPoint } from '@cloud/shared';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

const log = logger('history');

const UNITS: Record<HistoryMetric, 'ratio' | 'bytes_per_sec'> = {
  cpu: 'ratio',
  memory: 'ratio',
  net_rx: 'bytes_per_sec',
  net_tx: 'bytes_per_sec',
  disk_read: 'bytes_per_sec',
  disk_write: 'bytes_per_sec',
};

const RANGE_MS: Record<HistoryRange, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

/** Target point count per range — enough to draw, small enough to send. */
const RANGE_BUCKETS: Record<HistoryRange, number> = {
  '1h': 120,
  '24h': 144,
  '7d': 168,
  '30d': 180,
};

export function recordSamples(at: number, values: Partial<Record<HistoryMetric, number>>): void {
  const insert = db().prepare(
    'INSERT OR REPLACE INTO metric_samples (at, metric, value) VALUES (?, ?, ?)',
  );
  const tx = db().transaction(() => {
    for (const [metric, value] of Object.entries(values)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        insert.run(at, metric, value);
      }
    }
  });
  tx();
}

/**
 * Fold fine samples into hourly rollups and drop the fine rows past the
 * retention window. Without this the samples table grows without bound.
 */
export function rollup(): { rolled: number; pruned: number } {
  const conn = db();
  const cutoff = Date.now() - config.metrics.retentionHours * 3_600_000;
  const hourMs = 3_600_000;

  const rolled = conn
    .prepare(
      `INSERT INTO metric_rollups (hour, metric, avg_value, max_value, min_value, samples)
       SELECT (at / ?) * ?, metric, AVG(value), MAX(value), MIN(value), COUNT(*)
       FROM metric_samples
       WHERE at < ?
       GROUP BY metric, (at / ?)
       ON CONFLICT(metric, hour) DO UPDATE SET
         avg_value = excluded.avg_value,
         max_value = MAX(metric_rollups.max_value, excluded.max_value),
         min_value = MIN(metric_rollups.min_value, excluded.min_value),
         samples   = excluded.samples`,
    )
    .run(hourMs, hourMs, cutoff, hourMs).changes;

  const pruned = conn.prepare('DELETE FROM metric_samples WHERE at < ?').run(cutoff).changes;

  // Rollups older than 90 days are past any view we offer.
  conn
    .prepare('DELETE FROM metric_rollups WHERE hour < ?')
    .run(Date.now() - 90 * 86_400_000);

  if (rolled || pruned) log.debug(`rollup: ${rolled} hours, pruned ${pruned} samples`);
  return { rolled, pruned };
}

export function querySeries(metric: HistoryMetric, range: HistoryRange): HistorySeries {
  const span = RANGE_MS[range];
  const since = Date.now() - span;
  const buckets = RANGE_BUCKETS[range];
  const bucketMs = Math.max(1000, Math.floor(span / buckets));

  // Short ranges read fine samples; long ranges read hourly rollups.
  const useRollups = span > config.metrics.retentionHours * 3_600_000;

  const rows = useRollups
    ? (db()
        .prepare(
          `SELECT (hour / ?) * ? AS t, AVG(avg_value) AS v
           FROM metric_rollups WHERE metric = ? AND hour >= ?
           GROUP BY t ORDER BY t ASC`,
        )
        .all(bucketMs, bucketMs, metric, since) as { t: number; v: number }[])
    : (db()
        .prepare(
          `SELECT (at / ?) * ? AS t, AVG(value) AS v
           FROM metric_samples WHERE metric = ? AND at >= ?
           GROUP BY t ORDER BY t ASC`,
        )
        .all(bucketMs, bucketMs, metric, since) as { t: number; v: number }[]);

  const points: SeriesPoint[] = rows.map((r) => ({
    t: r.t,
    v: Math.round(r.v * 1000) / 1000,
  }));

  return { metric, range, unit: UNITS[metric], points };
}

/* ------------------------------------------------- monthly network usage */

function monthKey(at: number = Date.now()): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Accumulate the *delta* between polls rather than the interface counter
 * itself, so a reboot resetting /proc counters does not zero the month.
 */
export function addNetworkUsage(rxDelta: number, txDelta: number): void {
  if (rxDelta <= 0 && txDelta <= 0) return;
  db()
    .prepare(
      `INSERT INTO network_usage (month, rx_bytes, tx_bytes, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET
         rx_bytes = rx_bytes + excluded.rx_bytes,
         tx_bytes = tx_bytes + excluded.tx_bytes,
         updated_at = excluded.updated_at`,
    )
    .run(monthKey(), Math.max(0, Math.round(rxDelta)), Math.max(0, Math.round(txDelta)), Date.now());
}

export function currentMonthUsage(): { rx: number; tx: number } {
  const row = db()
    .prepare('SELECT rx_bytes, tx_bytes FROM network_usage WHERE month = ?')
    .get(monthKey()) as { rx_bytes: number; tx_bytes: number } | undefined;
  return { rx: row?.rx_bytes ?? 0, tx: row?.tx_bytes ?? 0 };
}
