import type { JellyfinStatus } from '@cloud/shared';
import { config } from '../config.js';
import { supervisor } from '../docker/supervisor.js';
import { SERVICE_KEYS } from '../profiles/definitions.js';
import { restartContainer } from '../docker/client.js';
import { badRequest, conflict } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('jellyfin');

/** Jellyfin can be slow while scanning; keep requests short and fail soft. */
const TIMEOUT_MS = 6000;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.jellyfin.enabled) {
    throw badRequest('Jellyfin is not configured. Set JELLYFIN_URL and JELLYFIN_API_KEY.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${config.jellyfin.url.replace(/\/$/, '')}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        // Jellyfin accepts the API key as a token header.
        'X-Emby-Token': config.jellyfin.apiKey,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Jellyfin responded ${response.status} ${response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface JellyfinSession {
  UserName?: string;
  Client?: string;
  NowPlayingItem?: {
    Name?: string;
    SeriesName?: string;
    RunTimeTicks?: number;
  };
  PlayState?: {
    PositionTicks?: number;
    PlayMethod?: string;
  };
  TranscodingInfo?: {
    Bitrate?: number;
    IsVideoDirect?: boolean;
  };
}

function playMethod(session: JellyfinSession): 'DirectPlay' | 'DirectStream' | 'Transcode' {
  const method = session.PlayState?.PlayMethod;
  if (method === 'Transcode') return 'Transcode';
  if (method === 'DirectStream') return 'DirectStream';
  return 'DirectPlay';
}

function displayName(session: JellyfinSession): string {
  const item = session.NowPlayingItem;
  if (!item) return 'Unknown';
  return item.SeriesName ? `${item.SeriesName} — ${item.Name ?? ''}`.trim() : item.Name ?? 'Unknown';
}

export async function status(): Promise<JellyfinStatus> {
  const container = supervisor.byServiceKey(SERVICE_KEYS.jellyfin);

  const base: JellyfinStatus = {
    online: false,
    streams: [],
    directPlayCount: 0,
    transcodeCount: 0,
    libraryItemCount: null,
    localMediaBytes: null,
    remoteMediaBytes: null,
    error: null,
  };

  if (container && container.state !== 'running') {
    base.error = 'The Jellyfin container is stopped.';
    return base;
  }
  if (!config.jellyfin.enabled) {
    base.online = container?.state === 'running';
    base.error = 'Jellyfin API credentials are not configured.';
    return base;
  }

  try {
    // Only sessions actually playing something are interesting here.
    const sessions = await call<JellyfinSession[]>('/Sessions?activeWithinSeconds=60');
    const playing = sessions.filter((s) => s.NowPlayingItem);

    base.online = true;
    base.streams = playing.map((s) => {
      const ticks = s.NowPlayingItem?.RunTimeTicks ?? 0;
      const position = s.PlayState?.PositionTicks ?? 0;
      return {
        user: s.UserName ?? 'Unknown',
        item: displayName(s),
        method: playMethod(s),
        progress: ticks > 0 ? Math.min(1, Math.max(0, position / ticks)) : 0,
        bitrateBps: s.TranscodingInfo?.Bitrate ?? null,
        client: s.Client ?? 'Unknown',
      };
    });

    base.transcodeCount = base.streams.filter((s) => s.method === 'Transcode').length;
    base.directPlayCount = base.streams.length - base.transcodeCount;
  } catch (err) {
    base.error = err instanceof Error ? err.message : 'Jellyfin is not responding.';
    log.debug('status call failed', err);
  }

  // The item count is a nice-to-have; never let it fail the whole status.
  try {
    const counts = await call<{ MovieCount?: number; SeriesCount?: number; EpisodeCount?: number }>(
      '/Items/Counts',
    );
    base.libraryItemCount =
      (counts.MovieCount ?? 0) + (counts.SeriesCount ?? 0) + (counts.EpisodeCount ?? 0);
  } catch {
    base.libraryItemCount = null;
  }

  return base;
}

export async function rescanLibraries(): Promise<void> {
  await call('/Library/Refresh', { method: 'POST' });
  log.info('library scan requested');
}

export async function restart(): Promise<void> {
  const container = supervisor.byServiceKey(SERVICE_KEYS.jellyfin);
  if (!container) throw conflict('The Jellyfin container is not deployed.');
  await restartContainer(container.id, 30);
}

/**
 * Stopping a transcode is the fastest way to reclaim CPU when the box is
 * struggling — a transcoding stream can consume every core it is allowed.
 */
export async function stopSession(sessionId: string): Promise<void> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId)) throw badRequest('Invalid session id.');
  await call(`/Sessions/${sessionId}/Playing/Stop`, { method: 'POST' });
}
