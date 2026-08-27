import type { Profile, ProfileId, ContainerLimits } from '@cloud/shared';

const GiB = 1024 ** 3;

/**
 * Service keys are the `cloud.service` label on each container. Profiles
 * address services by key rather than container name, so renaming a container
 * or moving it between compose files does not break resource management.
 */
export const SERVICE_KEYS = {
  jellyfin: 'jellyfin',
  nextcloud: 'nextcloud',
  minecraft: 'minecraft',
  desktop: 'desktop',
  database: 'database',
  proxy: 'proxy',
} as const;

function limits(cpus: number | null, memGiB: number | null, shares = 1024): ContainerLimits {
  return {
    cpus,
    memoryBytes: memGiB === null ? null : Math.round(memGiB * GiB),
    // Reserve half the ceiling — a soft floor the kernel honours under pressure.
    memoryReservationBytes: memGiB === null ? null : Math.round((memGiB / 2) * GiB),
    cpuShares: shares,
  };
}

/**
 * The machine has 4 vCPU and 16 GiB. CPU quotas are hard ceilings, so profiles
 * may sum above 4 — that is deliberate, since idle services never claim their
 * ceiling. `cpuShares` decides who wins when they all want it at once.
 */
export const PROFILES: Record<Exclude<ProfileId, 'custom'>, Profile> = {
  normal: {
    id: 'normal',
    name: 'Normal',
    description:
      'Everyday balance. Media and cloud stay responsive, games and desktops are off, background jobs run freely.',
    accent: '#38bdf8',
    allocations: [
      { serviceKey: 'jellyfin', action: 'run', limits: limits(2.0, 3, 1024) },
      { serviceKey: 'nextcloud', action: 'run', limits: limits(1.0, 2, 1024) },
      { serviceKey: 'database', action: 'run', limits: limits(1.0, 2, 1024) },
      { serviceKey: 'minecraft', action: 'stop', limits: limits(null, null) },
      { serviceKey: 'desktop', action: 'stop', limits: limits(null, null) },
    ],
    pauseJobs: [],
  },

  gaming: {
    id: 'gaming',
    name: 'Gaming',
    description:
      'Minecraft gets the machine. Media drops to direct-play only, desktops stop, heavy jobs pause.',
    accent: '#a78bfa',
    allocations: [
      // Paper is single-thread-bound; a high ceiling plus dominant shares keeps
      // tick time low even while Jellyfin is streaming.
      { serviceKey: 'minecraft', action: 'run', limits: limits(3.25, 8, 4096) },
      { serviceKey: 'jellyfin', action: 'run', limits: limits(0.75, 2, 512) },
      { serviceKey: 'nextcloud', action: 'run', limits: limits(0.5, 1.5, 256) },
      { serviceKey: 'database', action: 'run', limits: limits(0.5, 1.5, 512) },
      { serviceKey: 'desktop', action: 'stop', limits: limits(null, null) },
    ],
    pauseJobs: ['backup-nightly', 'tier-sweep', 'media-scan'],
  },

  media: {
    id: 'media',
    name: 'Media',
    description:
      'Jellyfin gets headroom for software transcoding. Everything else takes a back seat.',
    accent: '#fbbf24',
    allocations: [
      { serviceKey: 'jellyfin', action: 'run', limits: limits(3.5, 4, 4096) },
      { serviceKey: 'nextcloud', action: 'run', limits: limits(0.5, 1.5, 256) },
      { serviceKey: 'database', action: 'run', limits: limits(0.5, 1.5, 512) },
      { serviceKey: 'minecraft', action: 'stop', limits: limits(null, null) },
      { serviceKey: 'desktop', action: 'stop', limits: limits(null, null) },
    ],
    pauseJobs: ['tier-sweep'],
  },

  desktop: {
    id: 'desktop',
    name: 'Desktop',
    description:
      'A browser-delivered Linux desktop on demand, with enough left over to keep watching something.',
    accent: '#34d399',
    allocations: [
      { serviceKey: 'desktop', action: 'run', limits: limits(2.0, 4, 2048) },
      { serviceKey: 'jellyfin', action: 'run', limits: limits(1.0, 2, 1024) },
      { serviceKey: 'nextcloud', action: 'run', limits: limits(0.75, 2, 512) },
      { serviceKey: 'database', action: 'run', limits: limits(0.5, 1.5, 512) },
      { serviceKey: 'minecraft', action: 'stop', limits: limits(null, null) },
    ],
    pauseJobs: ['tier-sweep'],
  },
};

/** The accent the UI tints itself with while a custom profile is active. */
export const CUSTOM_ACCENT = '#f472b6';

export function profileById(id: ProfileId): Profile | null {
  if (id === 'custom') return null;
  return PROFILES[id] ?? null;
}

export function allProfiles(): Profile[] {
  return Object.values(PROFILES);
}
