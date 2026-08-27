import type {
  Profile, ProfileId, ProfileState, ProfileApplyResult, ProfileAllocation,
} from '@cloud/shared';
import { getSetting, setSetting } from '../db/index.js';
import {
  findByServiceKey, startContainer, stopContainer, updateLimits,
} from '../docker/client.js';
import { PROFILES, CUSTOM_ACCENT, profileById } from './definitions.js';
import { badRequest, notFound } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('profiles');

const STATE_KEY = 'profile.state';
const CUSTOM_KEY = 'profile.custom';

const DEFAULT_STATE: ProfileState = {
  active: 'normal',
  since: 0,
  appliedBy: 'user',
  pending: false,
};

export function currentState(): ProfileState {
  return getSetting<ProfileState>(STATE_KEY, DEFAULT_STATE);
}

export function customProfile(): Profile {
  return getSetting<Profile>(CUSTOM_KEY, {
    id: 'custom',
    name: 'Custom',
    description: 'Your own allocation, tuned by hand.',
    accent: CUSTOM_ACCENT,
    // Seeded from Normal so the sliders start somewhere sensible.
    allocations: PROFILES.normal.allocations,
    pauseJobs: [],
  });
}

export function saveCustomProfile(profile: Profile): Profile {
  const cleaned: Profile = {
    id: 'custom',
    name: 'Custom',
    description: profile.description?.slice(0, 200) || 'Your own allocation, tuned by hand.',
    accent: CUSTOM_ACCENT,
    allocations: validateAllocations(profile.allocations),
    pauseJobs: Array.isArray(profile.pauseJobs) ? profile.pauseJobs.slice(0, 20) : [],
  };
  setSetting(CUSTOM_KEY, cleaned);
  return cleaned;
}

/** Guards against a slider sending nonsense that Docker would reject anyway. */
function validateAllocations(allocations: ProfileAllocation[]): ProfileAllocation[] {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw badRequest('A profile needs at least one service allocation.');
  }
  if (allocations.length > 40) throw badRequest('Too many allocations.');

  return allocations.map((a) => {
    if (typeof a.serviceKey !== 'string' || !/^[a-z0-9._-]{1,60}$/i.test(a.serviceKey)) {
      throw badRequest(`Invalid service key: ${String(a.serviceKey)}`);
    }
    if (!['run', 'stop', 'leave'].includes(a.action)) {
      throw badRequest(`Invalid action for ${a.serviceKey}: ${String(a.action)}`);
    }
    const cpus = a.limits?.cpus;
    if (cpus !== null && cpus !== undefined && (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64)) {
      throw badRequest(`CPU limit for ${a.serviceKey} must be between 0 and 64 cores.`);
    }
    const mem = a.limits?.memoryBytes;
    if (mem !== null && mem !== undefined && (!Number.isFinite(mem) || mem < 6 * 1024 * 1024)) {
      throw badRequest(`Memory limit for ${a.serviceKey} must be at least 6 MiB.`);
    }
    return {
      serviceKey: a.serviceKey,
      action: a.action,
      limits: {
        cpus: cpus ?? null,
        memoryBytes: mem ?? null,
        memoryReservationBytes: a.limits?.memoryReservationBytes ?? null,
        cpuShares: a.limits?.cpuShares ?? null,
      },
    };
  });
}

export function resolveProfile(id: ProfileId): Profile {
  if (id === 'custom') return customProfile();
  const profile = profileById(id);
  if (!profile) throw notFound(`No profile named "${id}".`);
  return profile;
}

/**
 * Applying a profile is best-effort per service: one missing container must not
 * prevent the rest of the machine from being reconfigured. Every outcome is
 * reported back so the UI can show exactly what happened.
 */
export async function applyProfile(
  id: ProfileId,
  appliedBy: ProfileState['appliedBy'] = 'user',
): Promise<ProfileApplyResult> {
  const profile = resolveProfile(id);
  setSetting(STATE_KEY, { ...currentState(), pending: true });

  const changes: ProfileApplyResult['changes'] = [];

  // Stops run first, freeing CPU and RAM before anything tries to claim it.
  const ordered = [...profile.allocations].sort((a, b) => {
    const rank = (x: ProfileAllocation) => (x.action === 'stop' ? 0 : 1);
    return rank(a) - rank(b);
  });

  for (const allocation of ordered) {
    const result = { serviceKey: allocation.serviceKey, action: allocation.action, ok: true };
    try {
      const containerId = await findByServiceKey(allocation.serviceKey);
      if (!containerId) {
        // A service that is not deployed is not an error — it is just absent.
        changes.push({ ...result, ok: true, error: 'not deployed' });
        continue;
      }

      if (allocation.action === 'stop') {
        await stopContainer(containerId);
      } else if (allocation.action === 'run') {
        // Limits are applied before starting so the container never runs even
        // briefly with the previous profile's ceiling.
        await updateLimits(containerId, allocation.limits);
        await startContainer(containerId);
      } else {
        await updateLimits(containerId, allocation.limits);
      }
      changes.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`applying ${allocation.serviceKey} failed`, message);
      changes.push({ ...result, ok: false, error: message });
    }
  }

  setSetting(STATE_KEY, {
    active: id,
    since: Date.now(),
    appliedBy,
    pending: false,
  } satisfies ProfileState);

  log.info(`applied profile "${id}" (${changes.filter((c) => c.ok).length}/${changes.length} ok)`);
  return { profile: id, changes };
}

/**
 * Starting Minecraft should not require remembering to switch modes, and
 * stopping it should give the resources straight back. Only automatic
 * switches are reversed — a profile the user chose by hand is left alone.
 */
export async function onMinecraftStateChange(running: boolean): Promise<void> {
  const state = currentState();
  if (running && state.active !== 'gaming') {
    log.info('Minecraft started — switching to Gaming');
    await applyProfile('gaming', 'auto');
    return;
  }
  if (!running && state.active === 'gaming' && state.appliedBy === 'auto') {
    log.info('Minecraft stopped — restoring Normal');
    await applyProfile('normal', 'auto');
  }
}

export function activeAccent(): string {
  const state = currentState();
  if (state.active === 'custom') return CUSTOM_ACCENT;
  return PROFILES[state.active]?.accent ?? PROFILES.normal.accent;
}

/** Jobs the active profile has paused. */
export function pausedJobs(): string[] {
  const state = currentState();
  try {
    return resolveProfile(state.active).pauseJobs;
  } catch {
    return [];
  }
}
