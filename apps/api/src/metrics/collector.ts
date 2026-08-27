import type { HostSnapshot } from '@cloud/shared';
import { config } from '../config.js';
import { collectHostSnapshot, readNetCounters } from './host.js';
import { recordSamples, rollup, addNetworkUsage, currentMonthUsage } from './history.js';
import { pruneSessions } from '../auth/store.js';
import { pruneAttempts } from '../auth/ratelimit.js';
import { logger } from '../util/logger.js';

const log = logger('collector');

type Listener = (snapshot: HostSnapshot) => void;

/**
 * Owns the sampling loop. Everything that wants live host data subscribes
 * here rather than polling /proc itself.
 */
class Collector {
  private timer: NodeJS.Timeout | null = null;
  private rollupTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<Listener>();
  private latest: HostSnapshot | null = null;
  private lastNetCounters: { rx: number; tx: number } | null = null;
  private containerCounts = { running: 0, total: 0 };
  /** Persist a sample every Nth poll — 2s live, 30s stored. */
  private tick = 0;
  private readonly persistEvery: number;

  constructor() {
    this.persistEvery = Math.max(1, Math.round(30_000 / config.metrics.intervalMs));
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), config.metrics.intervalMs);
    this.timer.unref();

    // Housekeeping: rollups, expired sessions, stale login attempts.
    this.rollupTimer = setInterval(() => {
      try {
        rollup();
        pruneSessions();
        pruneAttempts();
      } catch (err) {
        log.error('housekeeping failed', err);
      }
    }, 600_000);
    this.rollupTimer.unref();
    log.info(`sampling every ${config.metrics.intervalMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.rollupTimer) clearInterval(this.rollupTimer);
    this.timer = null;
    this.rollupTimer = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): HostSnapshot | null {
    return this.latest;
  }

  /** Docker layer feeds counts in, so the collector needs no Docker dependency. */
  setContainerCounts(running: number, total: number): void {
    this.containerCounts = { running, total };
  }

  private async poll(): Promise<void> {
    try {
      await this.accumulateNetwork();
      const snapshot = await collectHostSnapshot({
        monthTotals: currentMonthUsage(),
        containersRunning: this.containerCounts.running,
        containersTotal: this.containerCounts.total,
      });
      this.latest = snapshot;

      if (++this.tick % this.persistEvery === 0) this.persist(snapshot);

      for (const fn of this.listeners) {
        try {
          fn(snapshot);
        } catch (err) {
          log.warn('listener threw', err);
        }
      }
    } catch (err) {
      log.error('poll failed', err);
    }
  }

  private persist(snapshot: HostSnapshot): void {
    const disks = snapshot.disks;
    const read = disks.reduce((a, d) => a + (d.readBytesPerSec ?? 0), 0);
    const write = disks.reduce((a, d) => a + (d.writeBytesPerSec ?? 0), 0);
    try {
      recordSamples(snapshot.at, {
        cpu: snapshot.cpu.usage,
        memory: snapshot.memory.totalBytes
          ? snapshot.memory.usedBytes / snapshot.memory.totalBytes
          : 0,
        net_rx: snapshot.network.rxBytesPerSec,
        net_tx: snapshot.network.txBytesPerSec,
        disk_read: read,
        disk_write: write,
      });
    } catch (err) {
      log.warn('persisting samples failed', err);
    }
  }

  /** Track interface counter deltas into the monthly allowance total. */
  private async accumulateNetwork(): Promise<void> {
    const counters = await readNetCounters(config.network.iface);
    if (!counters) return;
    const prev = this.lastNetCounters;
    this.lastNetCounters = counters;
    if (!prev) return;
    const rxDelta = counters.rx - prev.rx;
    const txDelta = counters.tx - prev.tx;
    // Negative means the counter wrapped or the host rebooted — skip the tick.
    if (rxDelta < 0 || txDelta < 0) return;
    addNetworkUsage(rxDelta, txDelta);
  }
}

export const collector = new Collector();
