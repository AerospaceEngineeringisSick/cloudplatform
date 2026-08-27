/**
 * Shared contract between the API and the dashboard.
 * Everything crossing the wire is described exactly once, here.
 */

/* ------------------------------------------------------------------ auth */

export type Role = 'owner' | 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  totpEnrolled: boolean;
  passkeyCount: number;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface SessionInfo {
  id: string;
  userAgent: string;
  ip: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

/** Login is two-legged: password first, then a second factor. */
export interface LoginChallenge {
  stage: 'totp' | 'complete';
  challengeId?: string;
  user?: User;
}

export interface AuditEntry {
  id: number;
  at: number;
  userId: string | null;
  username: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  outcome: 'ok' | 'denied' | 'error';
  detail: string | null;
}

/* --------------------------------------------------------------- metrics */

export interface CpuMetrics {
  /** 0..1 of total capacity across all cores. */
  usage: number;
  cores: number;
  /** Per-core usage 0..1, in core order. */
  perCore: number[];
  loadAvg: [number, number, number];
  /** Degrees celsius, null when the VPS does not expose sensors. */
  tempC: number | null;
}

export interface MemoryMetrics {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  cachedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export type DiskTier = 'nvme' | 'hdd' | 'remote';

export interface DiskMetrics {
  id: string;
  label: string;
  mountpoint: string;
  tier: DiskTier;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** False when a remote mount has dropped — surfaced prominently in the UI. */
  online: boolean;
  readBytesPerSec: number | null;
  writeBytesPerSec: number | null;
}

export interface NetworkMetrics {
  iface: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  /** Cumulative for the current billing month, used against the 80 TB allowance. */
  monthRxBytes: number;
  monthTxBytes: number;
  monthAllowanceBytes: number;
  linkSpeedMbps: number | null;
}

export interface HostSnapshot {
  at: number;
  uptimeSec: number;
  hostname: string;
  kernel: string;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disks: DiskMetrics[];
  network: NetworkMetrics;
  containersRunning: number;
  containersTotal: number;
}

/** One point in a downsampled history series. */
export interface SeriesPoint {
  t: number;
  v: number;
}

export type HistoryRange = '1h' | '24h' | '7d' | '30d';

export type HistoryMetric =
  | 'cpu'
  | 'memory'
  | 'net_rx'
  | 'net_tx'
  | 'disk_read'
  | 'disk_write';

export interface HistorySeries {
  metric: HistoryMetric;
  range: HistoryRange;
  /** Unit of `v`: 'ratio' 0..1, or 'bytes_per_sec'. */
  unit: 'ratio' | 'bytes_per_sec';
  points: SeriesPoint[];
}

/* ------------------------------------------------------------ containers */

export type ContainerState =
  | 'running'
  | 'exited'
  | 'created'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'dead';

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  status: string;
  /** Managed services carry a stable key so profiles can target them. */
  serviceKey: string | null;
  createdAt: number;
  startedAt: number | null;
  ports: { container: number; host: number | null; protocol: string }[];
  /** Live usage, present only while running. */
  cpuUsage: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
  restartCount: number;
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
}

export interface ContainerLimits {
  /** Cores, e.g. 3.25. Null means unlimited. */
  cpus: number | null;
  /** Bytes. Null means unlimited. */
  memoryBytes: number | null;
  /** Soft reservation in bytes. */
  memoryReservationBytes: number | null;
  /** -1000..1000, relative CPU weight under contention. */
  cpuShares: number | null;
}

/* -------------------------------------------------------------- profiles */

export type ProfileId = 'normal' | 'gaming' | 'media' | 'desktop' | 'custom';

export interface ProfileAllocation {
  serviceKey: string;
  /** 'run' starts the container, 'stop' stops it, 'leave' does not touch it. */
  action: 'run' | 'stop' | 'leave';
  limits: ContainerLimits;
}

export interface Profile {
  id: ProfileId;
  name: string;
  description: string;
  /** Chrome accent the UI tints itself with while this profile is active. */
  accent: string;
  allocations: ProfileAllocation[];
  /** Scheduled jobs paused while this profile is active. */
  pauseJobs: string[];
}

export interface ProfileState {
  active: ProfileId;
  since: number;
  /** Set when a profile was applied automatically, e.g. Minecraft starting. */
  appliedBy: 'user' | 'auto' | 'schedule';
  pending: boolean;
}

export interface ProfileApplyResult {
  profile: ProfileId;
  changes: {
    serviceKey: string;
    action: string;
    ok: boolean;
    error?: string;
  }[];
}

/* --------------------------------------------------------------- storage */

export interface StorageTierSummary {
  tier: DiskTier;
  label: string;
  mountpoint: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  online: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: number;
  /** Populated for directories only when explicitly computed. */
  childCount: number | null;
  mode: string;
}

export interface DirListing {
  path: string;
  tier: DiskTier;
  parent: string | null;
  entries: FileEntry[];
  /** True when the listing was truncated for size. */
  truncated: boolean;
}

export type TransferState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface Transfer {
  id: string;
  kind: 'move' | 'copy' | 'delete';
  source: string;
  destination: string;
  state: TransferState;
  bytesTotal: number;
  bytesDone: number;
  /** Bytes per second, computed over a short window. */
  speed: number;
  etaSec: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface TieringSummary {
  hotBytes: number;
  warmBytes: number;
  coldBytes: number;
  /** Candidates the automatic tiering rule would move on its next run. */
  candidates: { path: string; sizeBytes: number; lastAccessDays: number }[];
  ruleEnabled: boolean;
  coldAfterDays: number;
}

/* -------------------------------------------------------------- services */

export interface JellyfinStatus {
  online: boolean;
  streams: {
    user: string;
    item: string;
    method: 'DirectPlay' | 'DirectStream' | 'Transcode';
    /** 0..1 */
    progress: number;
    bitrateBps: number | null;
    client: string;
  }[];
  directPlayCount: number;
  transcodeCount: number;
  libraryItemCount: number | null;
  localMediaBytes: number | null;
  remoteMediaBytes: number | null;
  error: string | null;
}

export interface MinecraftStatus {
  online: boolean;
  /** Present only while the server is up and RCON answers. */
  players: { name: string }[];
  maxPlayers: number | null;
  tps: number | null;
  mspt: number | null;
  version: string | null;
  worldBytes: number | null;
  lastBackupAt: number | null;
  limits: ContainerLimits | null;
  error: string | null;
}

export interface UptimeCheck {
  id: string;
  name: string;
  target: string;
  kind: 'http' | 'tcp' | 'container' | 'mount';
  up: boolean;
  lastCheckedAt: number | null;
  latencyMs: number | null;
  /** 0..1 over the last 30 days. */
  uptime30d: number;
  /** One bucket per day, newest last. Null where no data was collected. */
  history: (number | null)[];
  enabled: boolean;
}

/* ------------------------------------------------------------------ jobs */

export type JobState = 'idle' | 'running' | 'failed' | 'disabled';

export interface Job {
  id: string;
  name: string;
  description: string;
  schedule: string;
  state: JobState;
  enabled: boolean;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextRunAt: number | null;
  /** Jobs paused by the active resource profile. */
  pausedByProfile: boolean;
}

export interface JobRun {
  id: number;
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  output: string;
}

/* -------------------------------------------------------------- websocket */

export type WsServerMessage =
  | { type: 'host'; data: HostSnapshot }
  | { type: 'containers'; data: ContainerSummary[] }
  | { type: 'profile'; data: ProfileState }
  | { type: 'transfers'; data: Transfer[] }
  | { type: 'uptime'; data: UptimeCheck[] }
  | { type: 'jobs'; data: Job[] }
  | { type: 'log'; data: { source: string; line: string; at: number } }
  | { type: 'notice'; data: { level: 'info' | 'warn' | 'error'; text: string } };

export type WsClientMessage =
  | { type: 'subscribe'; channels: string[] }
  | { type: 'ping' };

/* ------------------------------------------------------------------ misc */

export interface ApiError {
  error: string;
  message: string;
  /** Present on 429 responses. */
  retryAfterSec?: number;
}

export const BYTES = {
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
} as const;
