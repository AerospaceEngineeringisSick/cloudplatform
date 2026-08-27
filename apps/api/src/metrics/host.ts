import { readFile, statfs, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import type {
  CpuMetrics, MemoryMetrics, DiskMetrics, NetworkMetrics, HostSnapshot,
} from '@cloud/shared';
import { config } from '../config.js';
import { RateTracker, withTimeout } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('metrics');

/* ------------------------------------------------------------------- CPU */

interface CpuTimes {
  idle: number;
  total: number;
}

function parseCpuLine(line: string): CpuTimes | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const values = parts.slice(1).map(Number);
  if (values.some((v) => !Number.isFinite(v))) return null;
  // user nice system idle iowait irq softirq steal ...
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((a, b) => a + b, 0);
  return { idle, total };
}

let prevCpu: { aggregate: CpuTimes; cores: CpuTimes[] } | null = null;

function delta(prev: CpuTimes | undefined, cur: CpuTimes): number {
  if (!prev) return 0;
  const totalDelta = cur.total - prev.total;
  const idleDelta = cur.idle - prev.idle;
  if (totalDelta <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - idleDelta / totalDelta));
}

async function readCpu(): Promise<CpuMetrics> {
  const stat = await readFile('/proc/stat', 'utf8');
  const lines = stat.split('\n');
  const cores: CpuTimes[] = [];
  let aggregate: CpuTimes = { idle: 0, total: 0 };

  for (const line of lines) {
    if (!line.startsWith('cpu')) continue;
    const parsed = parseCpuLine(line);
    if (!parsed) continue;
    if (line.startsWith('cpu ')) aggregate = parsed;
    else cores.push(parsed);
  }

  const usage = delta(prevCpu?.aggregate, aggregate);
  const perCore = cores.map((c, i) => delta(prevCpu?.cores[i], c));
  prevCpu = { aggregate, cores };

  const loadRaw = await readFile('/proc/loadavg', 'utf8');
  const loadParts = loadRaw.split(/\s+/);
  const loadAvg: [number, number, number] = [
    Number(loadParts[0]) || 0,
    Number(loadParts[1]) || 0,
    Number(loadParts[2]) || 0,
  ];

  return {
    usage,
    cores: cores.length,
    perCore,
    loadAvg,
    tempC: await readTemperature(),
  };
}

/** Most VPS guests expose no sensors; a null reading is normal, not an error. */
async function readTemperature(): Promise<number | null> {
  try {
    const zones = await readdir('/sys/class/thermal');
    for (const zone of zones) {
      if (!zone.startsWith('thermal_zone')) continue;
      try {
        const raw = await readFile(`/sys/class/thermal/${zone}/temp`, 'utf8');
        const milli = Number(raw.trim());
        if (Number.isFinite(milli) && milli > 0) return Math.round(milli / 100) / 10;
      } catch {
        continue;
      }
    }
  } catch {
    // No thermal subsystem at all.
  }
  return null;
}

/* ---------------------------------------------------------------- memory */

async function readMemory(): Promise<MemoryMetrics> {
  const raw = await readFile('/proc/meminfo', 'utf8');
  const map = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const [key, value] = line.split(':');
    if (!key || !value) continue;
    // Values are in kB.
    map.set(key, Number(value.trim().split(/\s+/)[0]) * 1024);
  }
  const total = map.get('MemTotal') ?? 0;
  const available = map.get('MemAvailable') ?? 0;
  const swapTotal = map.get('SwapTotal') ?? 0;
  const swapFree = map.get('SwapFree') ?? 0;
  return {
    totalBytes: total,
    // "Used" excluding reclaimable cache — what people actually mean by used.
    usedBytes: Math.max(0, total - available),
    availableBytes: available,
    cachedBytes: (map.get('Cached') ?? 0) + (map.get('SReclaimable') ?? 0),
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

/* ----------------------------------------------------------------- disks */

const diskIoTrackers = new Map<string, { read: RateTracker; write: RateTracker }>();

/** Maps a mountpoint to its backing block device, for I/O counters. */
async function deviceForMount(mountpoint: string): Promise<string | null> {
  try {
    const mounts = await readFile('/proc/self/mounts', 'utf8');
    for (const line of mounts.split('\n')) {
      const [device, point] = line.split(/\s+/);
      if (point === mountpoint && device?.startsWith('/dev/')) {
        return device.replace('/dev/', '');
      }
    }
  } catch {
    // Fall through.
  }
  return null;
}

async function readDiskIo(device: string): Promise<{ read: number; write: number } | null> {
  try {
    const raw = await readFile('/proc/diskstats', 'utf8');
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts[2] !== device) continue;
      // Fields 6 and 10 are sectors read/written; sectors are 512 bytes.
      return {
        read: Number(parts[5]) * 512,
        write: Number(parts[9]) * 512,
      };
    }
  } catch {
    // Fall through.
  }
  return null;
}

async function readDisks(): Promise<DiskMetrics[]> {
  const results = await Promise.all(
    config.mounts.map(async (mount): Promise<DiskMetrics> => {
      const base: DiskMetrics = {
        id: mount.id,
        label: mount.label,
        mountpoint: mount.mountpoint,
        tier: mount.tier,
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        online: false,
        readBytesPerSec: null,
        writeBytesPerSec: null,
      };

      try {
        // A dead SFTP mount can block indefinitely — never let it stall the poll.
        const stats = await withTimeout(statfs(mount.mountpoint), 4000, `statfs ${mount.mountpoint}`);
        const total = stats.blocks * stats.bsize;
        const free = stats.bavail * stats.bsize;
        base.totalBytes = total;
        base.freeBytes = free;
        base.usedBytes = Math.max(0, total - stats.bfree * stats.bsize);
        base.online = true;
      } catch (err) {
        // Remote mounts drop; the UI shows this rather than pretending zero.
        if (mount.tier !== 'remote') {
          log.warn(`statfs failed for ${mount.mountpoint}`, err);
        }
        return base;
      }

      const device = await deviceForMount(mount.mountpoint);
      if (device) {
        const io = await readDiskIo(device);
        if (io) {
          let tracker = diskIoTrackers.get(mount.id);
          if (!tracker) {
            tracker = { read: new RateTracker(), write: new RateTracker() };
            diskIoTrackers.set(mount.id, tracker);
          }
          base.readBytesPerSec = tracker.read.sample(io.read);
          base.writeBytesPerSec = tracker.write.sample(io.write);
        }
      }
      return base;
    }),
  );
  return results;
}

/* --------------------------------------------------------------- network */

const rxTracker = new RateTracker();
const txTracker = new RateTracker();

export interface RawNetCounters {
  rx: number;
  tx: number;
}

export async function readNetCounters(iface: string): Promise<RawNetCounters | null> {
  try {
    const raw = await readFile('/proc/net/dev', 'utf8');
    for (const line of raw.split('\n')) {
      const [namePart, rest] = line.split(':');
      if (!namePart || !rest) continue;
      if (namePart.trim() !== iface) continue;
      const fields = rest.trim().split(/\s+/).map(Number);
      return { rx: fields[0] ?? 0, tx: fields[8] ?? 0 };
    }
  } catch (err) {
    log.warn('reading /proc/net/dev failed', err);
  }
  return null;
}

async function readNetwork(monthTotals: { rx: number; tx: number }): Promise<NetworkMetrics> {
  const counters = await readNetCounters(config.network.iface);
  return {
    iface: config.network.iface,
    rxBytesPerSec: counters ? rxTracker.sample(counters.rx) : 0,
    txBytesPerSec: counters ? txTracker.sample(counters.tx) : 0,
    monthRxBytes: monthTotals.rx,
    monthTxBytes: monthTotals.tx,
    monthAllowanceBytes: config.network.monthlyAllowanceBytes,
    linkSpeedMbps: config.network.linkSpeedMbps,
  };
}

/* -------------------------------------------------------------- snapshot */

async function readUptime(): Promise<number> {
  try {
    const raw = await readFile('/proc/uptime', 'utf8');
    return Math.floor(Number(raw.split(/\s+/)[0]) || 0);
  } catch {
    return 0;
  }
}

let kernelCache: string | null = null;
async function readKernel(): Promise<string> {
  if (kernelCache) return kernelCache;
  try {
    const raw = await readFile('/proc/version', 'utf8');
    kernelCache = raw.split(/\s+/).slice(0, 3).join(' ');
  } catch {
    kernelCache = 'unknown';
  }
  return kernelCache;
}

export async function collectHostSnapshot(opts: {
  monthTotals: { rx: number; tx: number };
  containersRunning: number;
  containersTotal: number;
}): Promise<HostSnapshot> {
  const [cpu, memory, disks, network, uptimeSec, kernel] = await Promise.all([
    readCpu(),
    readMemory(),
    readDisks(),
    readNetwork(opts.monthTotals),
    readUptime(),
    readKernel(),
  ]);

  return {
    at: Date.now(),
    uptimeSec,
    hostname: hostname(),
    kernel,
    cpu,
    memory,
    disks,
    network,
    containersRunning: opts.containersRunning,
    containersTotal: opts.containersTotal,
  };
}
