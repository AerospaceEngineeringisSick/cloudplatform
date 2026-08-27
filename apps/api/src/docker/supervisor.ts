import type { ContainerSummary } from '@cloud/shared';
import { listContainers, sampleStats, pruneStatsCache } from './client.js';
import { collector } from '../metrics/collector.js';
import { onMinecraftStateChange } from '../profiles/engine.js';
import { SERVICE_KEYS } from '../profiles/definitions.js';
import { mapLimit } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('supervisor');

type Listener = (containers: ContainerSummary[]) => void;

/**
 * Keeps a warm view of every container and its live usage, so the dashboard
 * never waits on Docker's slow stats endpoint.
 */
class Supervisor {
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<Listener>();
  private latest: ContainerSummary[] = [];
  private lastMinecraftRunning: boolean | null = null;
  private available = false;
  /** Suppresses a repeated stack trace while Docker stays unreachable. */
  private reportedUnavailable = false;

  async start(intervalMs = 5000): Promise<void> {
    if (this.timer) return;
    // Probe once so a missing Docker socket degrades gracefully rather than
    // throwing on every poll.
    try {
      await listContainers();
      this.available = true;
    } catch (err) {
      log.warn('Docker is not reachable — container features will be unavailable', err);
      this.available = false;
    }

    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  containers(): ContainerSummary[] {
    return this.latest;
  }

  isAvailable(): boolean {
    return this.available;
  }

  byServiceKey(key: string): ContainerSummary | undefined {
    return this.latest.find((c) => c.serviceKey === key);
  }

  private async poll(): Promise<void> {
    try {
      const containers = await listContainers();
      if (!this.available && this.reportedUnavailable) {
        log.info('Docker is reachable again');
      }
      this.available = true;
      this.reportedUnavailable = false;
      this.latest = containers;

      const running = containers.filter((c) => c.state === 'running');
      collector.setContainerCounts(running.length, containers.length);

      // Sample stats for running containers, a few at a time.
      await mapLimit(running, 4, async (c) => sampleStats(c.id));
      await pruneStatsCache(new Set(containers.map((c) => c.id)));

      // Re-read so the emitted view carries the stats we just sampled.
      this.latest = await listContainers();

      await this.detectMinecraftTransition();

      for (const fn of this.listeners) {
        try {
          fn(this.latest);
        } catch (err) {
          log.warn('listener threw', err);
        }
      }
    } catch (err) {
      this.available = false;
      if (!this.reportedUnavailable) {
        this.reportedUnavailable = true;
        log.error('Docker poll failed — container features are unavailable', err);
      }
    }
  }

  /** Drives the automatic Gaming-mode switch. */
  private async detectMinecraftTransition(): Promise<void> {
    const mc = this.byServiceKey(SERVICE_KEYS.minecraft);
    if (!mc) return;
    const running = mc.state === 'running';

    // The first poll only establishes a baseline; it must not trigger a switch.
    if (this.lastMinecraftRunning === null) {
      this.lastMinecraftRunning = running;
      return;
    }
    if (this.lastMinecraftRunning === running) return;

    this.lastMinecraftRunning = running;
    try {
      await onMinecraftStateChange(running);
    } catch (err) {
      log.error('automatic profile switch failed', err);
    }
  }
}

export const supervisor = new Supervisor();
