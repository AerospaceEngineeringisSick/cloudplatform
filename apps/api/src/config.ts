import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiskTier } from '@cloud/shared';

/** Read an env var, falling back to a `_FILE` variant so secrets can come from disk. */
function env(name: string, fallback?: string): string {
  const fileVar = process.env[`${name}_FILE`];
  if (fileVar && existsSync(fileVar)) return readFileSync(fileVar, 'utf8').trim();
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `Missing required configuration: ${name}. Set ${name} or ${name}_FILE in the environment.`,
  );
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export interface MountConfig {
  id: string;
  label: string;
  mountpoint: string;
  tier: DiskTier;
  /** Roots the file browser is allowed to touch on this mount. */
  browsable: boolean;
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * The session secret must be stable across restarts, or every session dies on
 * deploy. In production we refuse to invent one; in development a fixed
 * development-only value keeps the dev loop friction-free.
 */
function sessionSecret(): string {
  if (isProd) return env('SESSION_SECRET');
  return process.env.SESSION_SECRET ?? 'dev-only-insecure-secret-change-me-0000000000';
}

export const config = {
  isProd,

  /**
   * Binds loopback by default. The control plane is meant to sit behind Caddy
   * on the VPN interface, never directly on the public internet.
   */
  host: env('HOST', '127.0.0.1'),
  port: envNum('PORT', 8787),

  dataDir: resolve(env('DATA_DIR', './data')),
  sessionSecret: sessionSecret(),
  sessionTtlDays: envNum('SESSION_TTL_DAYS', 30),

  /** Public origin the dashboard is served from — WebAuthn binds credentials to it. */
  origin: env('PUBLIC_ORIGIN', 'http://localhost:5173'),
  rpId: env('WEBAUTHN_RP_ID', 'localhost'),
  rpName: env('WEBAUTHN_RP_NAME', 'Cloud Platform'),

  /** Serve the built dashboard from the API process (single-container deploy). */
  serveWeb: envBool('SERVE_WEB', isProd),
  webRoot: resolve(env('WEB_ROOT', '../web/dist')),

  /** Trust X-Forwarded-For only when a known reverse proxy sits in front. */
  trustProxy: envBool('TRUST_PROXY', true),

  docker: {
    socketPath: env('DOCKER_SOCKET', '/var/run/docker.sock'),
    /** Only containers carrying this label are treated as managed services. */
    serviceLabel: env('DOCKER_SERVICE_LABEL', 'cloud.service'),
  },

  mounts: parseMounts(),

  network: {
    iface: env('NET_IFACE', 'eth0'),
    /** 80 TB monthly allowance, expressed in bytes. */
    monthlyAllowanceBytes: envNum('NET_ALLOWANCE_BYTES', 80 * 1024 ** 4),
    linkSpeedMbps: envNum('NET_LINK_MBPS', 10_000),
  },

  jellyfin: {
    url: process.env.JELLYFIN_URL ?? '',
    apiKey: process.env.JELLYFIN_API_KEY ?? '',
    get enabled() {
      return this.url !== '' && this.apiKey !== '';
    },
  },

  minecraft: {
    rconHost: env('MC_RCON_HOST', '127.0.0.1'),
    rconPort: envNum('MC_RCON_PORT', 25575),
    rconPassword: process.env.MC_RCON_PASSWORD ?? '',
    worldPath: env('MC_WORLD_PATH', '/srv/minecraft'),
    backupPath: env('MC_BACKUP_PATH', '/mnt/storagebox/Backups/Minecraft'),
    get enabled() {
      return this.rconPassword !== '';
    },
  },

  rclone: {
    binary: env('RCLONE_BIN', 'rclone'),
    /** Remote name as configured in rclone.conf, e.g. "storagebox". */
    remote: env('RCLONE_REMOTE', 'storagebox'),
    configPath: process.env.RCLONE_CONFIG ?? '',
    /** Parallel transfer streams — the StorageBox is happiest around 4. */
    transfers: envNum('RCLONE_TRANSFERS', 4),
    bandwidthLimit: process.env.RCLONE_BWLIMIT ?? '',
  },

  metrics: {
    /** How often the host collector samples, in milliseconds. */
    intervalMs: envNum('METRICS_INTERVAL_MS', 2000),
    /** Rows kept in the fine-grained table before rollup prunes them. */
    retentionHours: envNum('METRICS_RETENTION_HOURS', 48),
  },

  security: {
    /** Failed logins allowed per window before the account is locked out. */
    maxLoginAttempts: envNum('MAX_LOGIN_ATTEMPTS', 8),
    loginWindowSec: envNum('LOGIN_WINDOW_SEC', 900),
    /** Require a fresh second factor for destructive actions. */
    requireStepUp: envBool('REQUIRE_STEP_UP', true),
    stepUpWindowSec: envNum('STEP_UP_WINDOW_SEC', 900),
  },
} as const;

/**
 * Mounts are declared as `id:label:mountpoint:tier` triples, comma separated.
 * The default describes the exact machine this platform was built for:
 * NVMe root, a mounted 1 TB HDD, and the remote StorageBox.
 */
function parseMounts(): MountConfig[] {
  const raw =
    process.env.MOUNTS ??
    'nvme:NVMe:/:nvme,hdd:HDD:/mnt/hdd:hdd,storagebox:StorageBox:/mnt/storagebox:remote';
  return raw.split(',').filter(Boolean).map((spec) => {
    const parts = spec.split(':');
    const [id, label, mountpoint, tier] = parts;
    if (!id || !label || !mountpoint || !tier) {
      throw new Error(`Malformed MOUNTS entry "${spec}" — expected id:label:mountpoint:tier`);
    }
    if (tier !== 'nvme' && tier !== 'hdd' && tier !== 'remote') {
      throw new Error(`Unknown tier "${tier}" in MOUNTS entry "${spec}"`);
    }
    return { id, label, mountpoint, tier, browsable: true };
  });
}

export function mountForTier(tier: DiskTier): MountConfig | undefined {
  return config.mounts.find((m) => m.tier === tier);
}
