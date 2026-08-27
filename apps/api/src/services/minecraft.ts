import { stat, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MinecraftStatus, ContainerLimits } from '@cloud/shared';
import { config } from '../config.js';
import { rcon, parsePlayerList, parseTps, parseMspt, stripColorCodes } from './rcon.js';
import { supervisor } from '../docker/supervisor.js';
import { SERVICE_KEYS } from '../profiles/definitions.js';
import {
  inspectContainer, startContainer, stopContainer, restartContainer,
} from '../docker/client.js';
import { startTransfer } from '../storage/transfers.js';
import { badRequest, conflict, HttpError } from '../util/index.js';
import { logger } from '../util/logger.js';

const log = logger('minecraft');

function rconOptions() {
  if (!config.minecraft.enabled) {
    throw badRequest('Minecraft RCON is not configured. Set MC_RCON_PASSWORD.');
  }
  return {
    host: config.minecraft.rconHost,
    port: config.minecraft.rconPort,
    password: config.minecraft.rconPassword,
  };
}

/** Directory size, capped so a huge world cannot stall the status endpoint. */
async function worldSize(): Promise<number | null> {
  const deadline = Date.now() + 5000;
  let bytes = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (Date.now() > deadline || depth > 8) return;
    let names: string[];
    try {
      names = await readdir(dir, { withFileTypes: true }).then((e) => e.map((x) => x.name));
    } catch {
      return;
    }
    for (const name of names) {
      if (Date.now() > deadline) return;
      try {
        const s = await stat(join(dir, name));
        if (s.isDirectory()) await walk(join(dir, name), depth + 1);
        else bytes += s.size;
      } catch {
        continue;
      }
    }
  };

  try {
    await stat(config.minecraft.worldPath);
  } catch {
    return null;
  }
  await walk(config.minecraft.worldPath, 0);
  return bytes;
}

async function lastBackupAt(): Promise<number | null> {
  try {
    const entries = await readdir(config.minecraft.backupPath);
    let newest = 0;
    for (const entry of entries) {
      try {
        const s = await stat(join(config.minecraft.backupPath, entry));
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      } catch {
        continue;
      }
    }
    return newest || null;
  } catch {
    return null;
  }
}

export async function status(): Promise<MinecraftStatus> {
  const container = supervisor.byServiceKey(SERVICE_KEYS.minecraft);
  const running = container?.state === 'running';

  const base: MinecraftStatus = {
    online: false,
    players: [],
    maxPlayers: null,
    tps: null,
    mspt: null,
    version: null,
    worldBytes: await worldSize(),
    lastBackupAt: await lastBackupAt(),
    limits: null,
    error: null,
  };

  if (container) {
    try {
      base.limits = (await inspectContainer(container.id)).limits;
    } catch {
      base.limits = null;
    }
  }

  if (!running) {
    base.error = container ? null : 'The Minecraft container is not deployed.';
    return base;
  }

  if (!config.minecraft.enabled) {
    base.online = true;
    base.error = 'RCON is not configured, so live stats are unavailable.';
    return base;
  }

  try {
    // Vanilla has no tps/mspt; those commands simply return an error string.
    const [listReply, tpsReply, msptReply] = await rcon(rconOptions(), [
      'list',
      'tps',
      'mspt',
    ]);
    const list = parsePlayerList(listReply ?? '');
    base.online = true;
    base.players = list.names.map((name) => ({ name }));
    base.maxPlayers = list.max;
    base.tps = tpsReply ? parseTps(tpsReply) : null;
    base.mspt = msptReply ? parseMspt(msptReply) : null;
  } catch (err) {
    // The container can be up while the server is still loading its world.
    base.online = true;
    base.error =
      err instanceof HttpError ? err.message : 'The server is starting or not answering RCON.';
  }

  return base;
}

/** Commands that would let the console be used to take over the host. */
const BLOCKED_COMMANDS = [/^\s*stop\b/i, /^\s*\/?op\b/i, /^\s*\/?deop\b/i];

export async function runCommand(command: string): Promise<string> {
  const trimmed = command.trim();
  if (!trimmed) throw badRequest('Enter a command.');
  if (trimmed.length > 500) throw badRequest('That command is too long.');
  // `stop` bypasses the graceful shutdown the platform performs; op changes
  // belong to a deliberate action, not a console one-liner.
  if (BLOCKED_COMMANDS.some((re) => re.test(trimmed))) {
    throw badRequest(
      'Use the Stop button rather than the console for that command.',
    );
  }
  const [reply] = await rcon(rconOptions(), [trimmed.replace(/^\//, '')]);
  return stripColorCodes(reply ?? '');
}

function requireContainer(): string {
  const container = supervisor.byServiceKey(SERVICE_KEYS.minecraft);
  if (!container) throw conflict('The Minecraft container is not deployed.');
  return container.id;
}

export async function start(): Promise<void> {
  await startContainer(requireContainer());
  log.info('start requested');
}

/**
 * Saves and flushes the world through RCON before stopping the container, so
 * a stop never costs recent progress.
 */
export async function stop(): Promise<void> {
  const id = requireContainer();
  if (config.minecraft.enabled) {
    try {
      await rcon(rconOptions(), ['save-all flush', 'say Server shutting down in 5 seconds']);
      await new Promise((r) => setTimeout(r, 5000));
    } catch (err) {
      log.warn('pre-stop save failed; stopping anyway', err);
    }
  }
  await stopContainer(id, 60);
  log.info('stopped');
}

export async function restart(): Promise<void> {
  const id = requireContainer();
  if (config.minecraft.enabled) {
    try {
      await rcon(rconOptions(), ['save-all flush']);
    } catch {
      // Not fatal — the container restart still proceeds.
    }
  }
  await restartContainer(id, 60);
}

/**
 * Backs the world up to the StorageBox. The world is flushed and saving is
 * paused first, so the copy is consistent rather than a torn snapshot.
 */
export async function backup(): Promise<{ transferId: string; destination: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destination = `Backups/Minecraft/world-${stamp}`;

  let pausedSaving = false;
  if (config.minecraft.enabled && supervisor.byServiceKey(SERVICE_KEYS.minecraft)?.state === 'running') {
    try {
      await rcon(rconOptions(), ['save-off', 'save-all flush']);
      pausedSaving = true;
    } catch (err) {
      log.warn('could not pause saving before backup', err);
    }
  }

  try {
    await mkdir(config.minecraft.backupPath, { recursive: true });
  } catch {
    // The remote mount creates directories on write; not fatal.
  }

  try {
    const transfer = await startTransfer({
      kind: 'copy',
      sourceMount: 'nvme',
      sourcePath: config.minecraft.worldPath.replace(/^\//, ''),
      destMount: 'storagebox',
      destPath: destination,
    });
    return { transferId: transfer.id, destination };
  } finally {
    // Saving must resume even if the transfer failed to start.
    if (pausedSaving) {
      try {
        await rcon(rconOptions(), ['save-on']);
      } catch (err) {
        log.error('FAILED TO RE-ENABLE WORLD SAVING — run "save-on" manually', err);
      }
    }
  }
}

export function limitsFor(): ContainerLimits | null {
  const container = supervisor.byServiceKey(SERVICE_KEYS.minecraft);
  if (!container) return null;
  return {
    cpus: null,
    memoryBytes: container.memLimitBytes,
    memoryReservationBytes: null,
    cpuShares: null,
  };
}
