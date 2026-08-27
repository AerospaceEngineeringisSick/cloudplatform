import Docker from 'dockerode';
import type { ContainerSummary, ContainerState, ContainerLimits } from '@cloud/shared';
import { config } from '../config.js';
import { notFound, badRequest, RateTracker, clamp } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('docker');

export const docker = new Docker({ socketPath: config.docker.socketPath });

/** Docker expresses CPU quota against a period; 100 ms is the conventional one. */
const CPU_PERIOD = 100_000;

export function cpusToQuota(cpus: number): number {
  return Math.round(cpus * CPU_PERIOD);
}

export function quotaToCpus(quota: number, period: number): number | null {
  if (!quota || quota <= 0) return null;
  return Math.round((quota / (period || CPU_PERIOD)) * 100) / 100;
}

interface StatsCache {
  cpu: number;
  memUsed: number;
  memLimit: number;
  rx: number;
  tx: number;
  at: number;
}

const statsCache = new Map<string, StatsCache>();
const netTrackers = new Map<string, { rx: RateTracker; tx: RateTracker }>();

/**
 * Docker's stats endpoint is slow (it samples for a second). We poll it in the
 * background per container and serve the cached value, so listing containers
 * stays fast no matter how many are running.
 */
export async function sampleStats(id: string): Promise<void> {
  try {
    const container = docker.getContainer(id);
    const stats = (await container.stats({ stream: false })) as unknown as DockerStats;

    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta =
      stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage ?? 0);
    const onlineCpus =
      stats.cpu_stats.online_cpus ?? stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;

    // Expressed in cores, so 2.5 means "two and a half of the four vCPUs".
    const cpu =
      systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus : 0;

    // Docker's `usage` counts page cache; subtracting it matches what `docker
    // stats` reports and what people expect to see.
    const cache = stats.memory_stats.stats?.inactive_file ?? 0;
    const memUsed = Math.max(0, (stats.memory_stats.usage ?? 0) - cache);

    let rxTotal = 0;
    let txTotal = 0;
    for (const iface of Object.values(stats.networks ?? {})) {
      rxTotal += iface.rx_bytes;
      txTotal += iface.tx_bytes;
    }
    let tracker = netTrackers.get(id);
    if (!tracker) {
      tracker = { rx: new RateTracker(), tx: new RateTracker() };
      netTrackers.set(id, tracker);
    }

    statsCache.set(id, {
      cpu,
      memUsed,
      memLimit: stats.memory_stats.limit ?? 0,
      rx: tracker.rx.sample(rxTotal),
      tx: tracker.tx.sample(txTotal),
      at: Date.now(),
    });
  } catch {
    // Container stopped mid-sample; drop its cache entry.
    statsCache.delete(id);
    netTrackers.delete(id);
  }
}

interface DockerStats {
  cpu_stats: {
    cpu_usage: { total_usage: number; percpu_usage?: number[] };
    system_cpu_usage: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage: number };
    system_cpu_usage?: number;
  };
  memory_stats: {
    usage?: number;
    limit?: number;
    stats?: { inactive_file?: number };
  };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
}

function normaliseName(names: string[] | undefined): string {
  const raw = names?.[0] ?? '';
  return raw.replace(/^\//, '');
}

export async function listContainers(): Promise<ContainerSummary[]> {
  const raw = await docker.listContainers({ all: true });

  return raw.map((c): ContainerSummary => {
    const cached = statsCache.get(c.Id);
    const fresh = cached && Date.now() - cached.at < 15_000;
    const state = c.State as ContainerState;
    const serviceKey = c.Labels?.[config.docker.serviceLabel] ?? null;

    return {
      id: c.Id,
      name: normaliseName(c.Names),
      image: c.Image,
      state,
      status: c.Status,
      serviceKey,
      createdAt: c.Created * 1000,
      startedAt: null,
      ports: (c.Ports ?? []).map((p) => ({
        container: p.PrivatePort,
        host: p.PublicPort ?? null,
        protocol: p.Type ?? 'tcp',
      })),
      cpuUsage: state === 'running' && fresh ? cached!.cpu : null,
      memUsedBytes: state === 'running' && fresh ? cached!.memUsed : null,
      memLimitBytes: state === 'running' && fresh ? cached!.memLimit : null,
      netRxBytesPerSec: state === 'running' && fresh ? cached!.rx : null,
      netTxBytesPerSec: state === 'running' && fresh ? cached!.tx : null,
      restartCount: 0,
      health: 'none',
    };
  });
}

/** Full inspect for a single container — adds health, restarts and limits. */
export async function inspectContainer(idOrName: string): Promise<{
  summary: ContainerSummary;
  limits: ContainerLimits;
  env: string[];
  mounts: { source: string; destination: string; mode: string }[];
}> {
  const container = docker.getContainer(idOrName);
  let info;
  try {
    info = await container.inspect();
  } catch {
    throw notFound(`No container named "${idOrName}".`);
  }

  const cached = statsCache.get(info.Id);
  const fresh = cached && Date.now() - cached.at < 15_000;
  const state = info.State.Status as ContainerState;
  const hc = info.State.Health?.Status;

  const limits: ContainerLimits = {
    cpus: quotaToCpus(info.HostConfig.CpuQuota ?? 0, info.HostConfig.CpuPeriod ?? CPU_PERIOD),
    memoryBytes: info.HostConfig.Memory ? info.HostConfig.Memory : null,
    memoryReservationBytes: info.HostConfig.MemoryReservation
      ? info.HostConfig.MemoryReservation
      : null,
    cpuShares: info.HostConfig.CpuShares ? info.HostConfig.CpuShares : null,
  };

  return {
    summary: {
      id: info.Id,
      name: info.Name.replace(/^\//, ''),
      image: info.Config.Image,
      state,
      status: info.State.Status,
      serviceKey: info.Config.Labels?.[config.docker.serviceLabel] ?? null,
      createdAt: Date.parse(info.Created),
      startedAt: info.State.StartedAt ? Date.parse(info.State.StartedAt) : null,
      ports: Object.entries(info.NetworkSettings.Ports ?? {}).map(([key, value]) => {
        const [portStr, protocol] = key.split('/');
        const bindings = value as { HostPort: string }[] | null;
        return {
          container: Number(portStr),
          host: bindings?.[0] ? Number(bindings[0].HostPort) : null,
          protocol: protocol ?? 'tcp',
        };
      }),
      cpuUsage: state === 'running' && fresh ? cached!.cpu : null,
      memUsedBytes: state === 'running' && fresh ? cached!.memUsed : null,
      memLimitBytes: state === 'running' && fresh ? cached!.memLimit : null,
      netRxBytesPerSec: state === 'running' && fresh ? cached!.rx : null,
      netTxBytesPerSec: state === 'running' && fresh ? cached!.tx : null,
      restartCount: info.RestartCount ?? 0,
      health:
        hc === 'healthy' || hc === 'unhealthy' || hc === 'starting' ? hc : 'none',
    },
    limits,
    env: (info.Config.Env ?? []).map(redactEnv),
    mounts: (info.Mounts ?? []).map((m) => ({
      source: m.Source,
      destination: m.Destination,
      mode: m.RW ? 'rw' : 'ro',
    })),
  };
}

/** Container env routinely holds passwords; never hand them to the browser. */
const SECRET_PATTERN = /(PASS|SECRET|TOKEN|KEY|CREDENTIAL|AUTH|PWD|SALT|PRIVATE)/i;

export function redactEnv(entry: string): string {
  const eq = entry.indexOf('=');
  if (eq === -1) return entry;
  const name = entry.slice(0, eq);
  return SECRET_PATTERN.test(name) ? `${name}=••••••••` : entry;
}

/* ------------------------------------------------------------- lifecycle */

export async function startContainer(idOrName: string): Promise<void> {
  try {
    await docker.getContainer(idOrName).start();
  } catch (err) {
    const e = err as { statusCode?: number };
    // 304 means it was already running, which is the state we wanted anyway.
    if (e.statusCode === 304) return;
    throw err;
  }
}

export async function stopContainer(idOrName: string, timeoutSec = 30): Promise<void> {
  try {
    await docker.getContainer(idOrName).stop({ t: timeoutSec });
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode === 304) return;
    throw err;
  }
}

export async function restartContainer(idOrName: string, timeoutSec = 30): Promise<void> {
  await docker.getContainer(idOrName).restart({ t: timeoutSec });
}

/**
 * Applies cgroup limits to a running container without recreating it.
 * This is what makes the profile switcher instant rather than a redeploy.
 */
export async function updateLimits(idOrName: string, limits: ContainerLimits): Promise<void> {
  const update: Record<string, number> = {};

  if (limits.cpus !== null) {
    if (limits.cpus <= 0 || limits.cpus > 256) {
      throw badRequest('CPU limit must be between 0 and 256 cores.');
    }
    update.CpuPeriod = CPU_PERIOD;
    update.CpuQuota = cpusToQuota(limits.cpus);
  } else {
    update.CpuQuota = 0;
  }

  if (limits.memoryBytes !== null) {
    // Docker rejects limits under 6 MiB outright.
    if (limits.memoryBytes < 6 * 1024 * 1024) {
      throw badRequest('Memory limit must be at least 6 MiB.');
    }
    update.Memory = Math.round(limits.memoryBytes);
    // Swap must move with memory or Docker keeps the old, lower ceiling.
    update.MemorySwap = Math.round(limits.memoryBytes);
  } else {
    update.Memory = 0;
    update.MemorySwap = 0;
  }

  if (limits.memoryReservationBytes !== null) {
    update.MemoryReservation = Math.round(limits.memoryReservationBytes);
  }

  if (limits.cpuShares !== null) {
    update.CpuShares = clamp(Math.round(limits.cpuShares), 2, 262_144);
  }

  await docker.getContainer(idOrName).update(update);
  log.info(`updated limits for ${idOrName}`, update);
}

export async function containerLogs(
  idOrName: string,
  lines = 200,
): Promise<string> {
  const buffer = (await docker.getContainer(idOrName).logs({
    stdout: true,
    stderr: true,
    tail: clamp(lines, 1, 5000),
    timestamps: false,
  })) as unknown as Buffer;
  return demultiplex(buffer);
}

/**
 * Docker multiplexes stdout/stderr into a framed stream when the container has
 * no TTY. Each frame is an 8-byte header followed by its payload.
 */
export function demultiplex(buffer: Buffer): string {
  const chunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer[offset];
    // A valid frame header starts with a stream type of 0..2.
    if (type !== 0 && type !== 1 && type !== 2) break;
    const length = buffer.readUInt32BE(offset + 4);
    if (length > buffer.length - offset - 8) break;
    chunks.push(buffer.toString('utf8', offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  // Not framed after all (TTY containers) — return it as plain text.
  if (chunks.length === 0) return buffer.toString('utf8');
  return chunks.join('');
}

/** Resolve a service key like "jellyfin" to its container id. */
export async function findByServiceKey(key: string): Promise<string | null> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${config.docker.serviceLabel}=${key}`] },
  });
  return containers[0]?.Id ?? null;
}

export async function pruneStatsCache(liveIds: Set<string>): Promise<void> {
  for (const id of statsCache.keys()) {
    if (!liveIds.has(id)) {
      statsCache.delete(id);
      netTrackers.delete(id);
    }
  }
}
