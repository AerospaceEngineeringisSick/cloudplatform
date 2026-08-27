import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HistoryMetric, HistoryRange, ProfileId, Profile } from '@cloud/shared';
import { collector } from '../metrics/collector.js';
import { querySeries } from '../metrics/history.js';
import { supervisor } from '../docker/supervisor.js';
import {
  inspectContainer, startContainer, stopContainer, restartContainer,
  containerLogs, updateLimits,
} from '../docker/client.js';
import {
  applyProfile, currentState, customProfile, saveCustomProfile, resolveProfile,
} from '../profiles/engine.js';
import { allProfiles } from '../profiles/definitions.js';
import { listJobs, listRuns, runJob, setJobEnabled } from '../jobs/scheduler.js';
import {
  listChecks, createCheck, deleteCheck, setCheckEnabled,
} from '../services/uptime.js';
import * as jellyfin from '../services/jellyfin.js';
import * as minecraft from '../services/minecraft.js';
import { requireAuth, requireRole, requireStepUp, clientIp } from '../auth/guard.js';
import { audit } from '../auth/store.js';
import { badRequest, notFound, conflict } from '../util/index.js';
import { config } from '../config.js';

const HISTORY_METRICS: HistoryMetric[] = [
  'cpu', 'memory', 'net_rx', 'net_tx', 'disk_read', 'disk_write',
];
const HISTORY_RANGES: HistoryRange[] = ['1h', '24h', '7d', '30d'];

function bodyOf<T>(req: FastifyRequest): T {
  if (!req.body || typeof req.body !== 'object') throw badRequest('Expected a JSON body.');
  return req.body as T;
}

function trail(req: FastifyRequest, action: string, target?: string, detail?: string): void {
  audit({
    userId: req.auth?.user.id ?? null,
    username: req.auth?.user.username ?? null,
    action,
    target: target ?? null,
    ip: clientIp(req),
    outcome: 'ok',
    detail: detail ?? null,
  });
}

/** Container ids come from the URL; only accept what Docker actually issues. */
function containerId(req: FastifyRequest): string {
  const id = (req.params as { id: string }).id;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) throw badRequest('Invalid container id.');
  return id;
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /* -------------------------------------------------------------- overview */

  app.get('/api/host', async () => {
    const snapshot = collector.snapshot();
    if (!snapshot) throw conflict('Metrics are still starting up. Try again in a moment.');
    return snapshot;
  });

  app.get('/api/host/history', async (req) => {
    const q = req.query as { metric?: string; range?: string };
    const metric = q.metric as HistoryMetric;
    const range = (q.range ?? '1h') as HistoryRange;
    if (!HISTORY_METRICS.includes(metric)) {
      throw badRequest(`metric must be one of: ${HISTORY_METRICS.join(', ')}`);
    }
    if (!HISTORY_RANGES.includes(range)) {
      throw badRequest(`range must be one of: ${HISTORY_RANGES.join(', ')}`);
    }
    return querySeries(metric, range);
  });

  app.get('/api/overview', async () => {
    const [jellyfinStatus, minecraftStatus] = await Promise.all([
      jellyfin.status().catch(() => null),
      minecraft.status().catch(() => null),
    ]);
    return {
      host: collector.snapshot(),
      containers: supervisor.containers(),
      profile: currentState(),
      uptime: listChecks(),
      jellyfin: jellyfinStatus,
      minecraft: minecraftStatus,
      dockerAvailable: supervisor.isAvailable(),
    };
  });

  /* ------------------------------------------------------------ containers */

  app.get('/api/containers', async () => supervisor.containers());

  app.get('/api/containers/:id', async (req) => inspectContainer(containerId(req)));

  app.get('/api/containers/:id/logs', async (req) => {
    const q = req.query as { lines?: string };
    const lines = Math.min(Number(q.lines ?? 200) || 200, 2000);
    return { logs: await containerLogs(containerId(req), lines) };
  });

  app.post(
    '/api/containers/:id/:action',
    { preHandler: requireRole('admin') },
    async (req) => {
      const id = containerId(req);
      const action = (req.params as { action: string }).action;
      switch (action) {
        case 'start':
          await startContainer(id);
          break;
        case 'stop':
          await stopContainer(id);
          break;
        case 'restart':
          await restartContainer(id);
          break;
        default:
          throw badRequest('Action must be start, stop or restart.');
      }
      trail(req, `container.${action}`, id);
      return { ok: true };
    },
  );

  app.put(
    '/api/containers/:id/limits',
    { preHandler: requireRole('admin') },
    async (req) => {
      const id = containerId(req);
      const b = bodyOf<{
        cpus?: number | null;
        memoryBytes?: number | null;
        memoryReservationBytes?: number | null;
        cpuShares?: number | null;
      }>(req);

      await updateLimits(id, {
        cpus: b.cpus ?? null,
        memoryBytes: b.memoryBytes ?? null,
        memoryReservationBytes: b.memoryReservationBytes ?? null,
        cpuShares: b.cpuShares ?? null,
      });
      trail(req, 'container.limits', id, JSON.stringify(b));
      return inspectContainer(id);
    },
  );

  /* -------------------------------------------------------------- profiles */

  app.get('/api/profiles', async () => ({
    profiles: [...allProfiles(), customProfile()],
    state: currentState(),
  }));

  app.post('/api/profiles/:id/apply', { preHandler: requireRole('admin') }, async (req) => {
    const id = (req.params as { id: string }).id as ProfileId;
    // resolveProfile rejects anything that is not a real profile.
    resolveProfile(id);
    const result = await applyProfile(id, 'user');
    trail(req, 'profile.apply', id, `${result.changes.filter((c) => c.ok).length} ok`);
    return result;
  });

  app.put('/api/profiles/custom', { preHandler: requireRole('admin') }, async (req) => {
    const saved = saveCustomProfile(bodyOf<Profile>(req));
    trail(req, 'profile.custom.save');
    return saved;
  });

  /* --------------------------------------------------------------- storage */

  app.get('/api/storage/tiers', async () => {
    const { tierSummaries } = await import('../storage/browser.js');
    return tierSummaries();
  });

  app.get('/api/storage/list', async (req) => {
    const q = req.query as { mount?: string; path?: string };
    const { listDirectory } = await import('../storage/browser.js');
    return listDirectory(q.mount ?? 'nvme', q.path ?? '');
  });

  app.get('/api/storage/size', async (req) => {
    const q = req.query as { mount?: string; path?: string };
    const { directorySize } = await import('../storage/browser.js');
    return directorySize(q.mount ?? 'nvme', q.path ?? '');
  });

  app.get('/api/storage/download', async (req, reply) => {
    const q = req.query as { mount?: string; path?: string };
    const { openDownload } = await import('../storage/browser.js');
    const file = await openDownload(q.mount ?? 'nvme', q.path ?? '');
    // The filename is quoted and escaped so it cannot break out of the header.
    const safeName = file.filename.replace(/["\\\r\n]/g, '_');
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', file.size)
      .header('Content-Disposition', `attachment; filename="${safeName}"`);
    return reply.send(file.stream);
  });

  app.post('/api/storage/folder', { preHandler: requireRole('admin') }, async (req) => {
    const b = bodyOf<{ mount: string; path: string; name: string }>(req);
    const { createFolder } = await import('../storage/browser.js');
    await createFolder(b.mount, b.path ?? '', b.name);
    trail(req, 'storage.mkdir', `${b.mount}:/${b.path}/${b.name}`);
    return { ok: true };
  });

  app.post('/api/storage/rename', { preHandler: requireRole('admin') }, async (req) => {
    const b = bodyOf<{ mount: string; path: string; name: string }>(req);
    const { renameEntry } = await import('../storage/browser.js');
    await renameEntry(b.mount, b.path, b.name);
    trail(req, 'storage.rename', `${b.mount}:/${b.path}`, `to ${b.name}`);
    return { ok: true };
  });

  app.post(
    '/api/storage/delete',
    { preHandler: [requireRole('admin'), requireStepUp] },
    async (req) => {
      const b = bodyOf<{ mount: string; path: string }>(req);
      const { deleteEntry } = await import('../storage/browser.js');
      await deleteEntry(b.mount, b.path);
      trail(req, 'storage.delete', `${b.mount}:/${b.path}`);
      return { ok: true };
    },
  );

  /* ------------------------------------------------------------- transfers */

  app.get('/api/transfers', async () => {
    const { listTransfers } = await import('../storage/transfers.js');
    return listTransfers();
  });

  app.post('/api/transfers', { preHandler: requireRole('admin') }, async (req) => {
    const b = bodyOf<{
      kind: 'move' | 'copy';
      sourceMount: string;
      sourcePath: string;
      destMount: string;
      destPath: string;
    }>(req);
    if (b.kind !== 'move' && b.kind !== 'copy') throw badRequest('kind must be move or copy.');
    const { startTransfer } = await import('../storage/transfers.js');
    const transfer = await startTransfer(b);
    trail(req, `storage.${b.kind}`, `${b.sourceMount}:/${b.sourcePath}`, `to ${b.destMount}:/${b.destPath}`);
    return transfer;
  });

  app.delete('/api/transfers/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { cancelTransfer } = await import('../storage/transfers.js');
    cancelTransfer((req.params as { id: string }).id);
    trail(req, 'storage.transfer.cancel', (req.params as { id: string }).id);
    return { ok: true };
  });

  /* --------------------------------------------------------------- tiering */

  app.get('/api/storage/tiering', async () => {
    const { summarise, rules } = await import('../storage/tiering.js');
    return { summary: await summarise(), rules: rules() };
  });

  app.put('/api/storage/tiering', { preHandler: requireRole('admin') }, async (req) => {
    const { saveRules } = await import('../storage/tiering.js');
    const saved = saveRules(bodyOf(req));
    trail(req, 'storage.tiering.rules', undefined, JSON.stringify(saved));
    return saved;
  });

  /* -------------------------------------------------------------- jellyfin */

  app.get('/api/jellyfin', async () => jellyfin.status());

  app.post('/api/jellyfin/rescan', { preHandler: requireRole('admin') }, async (req) => {
    await jellyfin.rescanLibraries();
    trail(req, 'jellyfin.rescan');
    return { ok: true };
  });

  app.post('/api/jellyfin/restart', { preHandler: requireRole('admin') }, async (req) => {
    await jellyfin.restart();
    trail(req, 'jellyfin.restart');
    return { ok: true };
  });

  /* ------------------------------------------------------------- minecraft */

  app.get('/api/minecraft', async () => minecraft.status());

  app.post('/api/minecraft/start', { preHandler: requireRole('admin') }, async (req) => {
    await minecraft.start();
    trail(req, 'minecraft.start');
    return { ok: true };
  });

  app.post('/api/minecraft/stop', { preHandler: requireRole('admin') }, async (req) => {
    await minecraft.stop();
    trail(req, 'minecraft.stop');
    return { ok: true };
  });

  app.post('/api/minecraft/restart', { preHandler: requireRole('admin') }, async (req) => {
    await minecraft.restart();
    trail(req, 'minecraft.restart');
    return { ok: true };
  });

  app.post('/api/minecraft/backup', { preHandler: requireRole('admin') }, async (req) => {
    const result = await minecraft.backup();
    trail(req, 'minecraft.backup', result.destination);
    return result;
  });

  app.post('/api/minecraft/command', { preHandler: requireRole('admin') }, async (req) => {
    const b = bodyOf<{ command: string }>(req);
    const output = await minecraft.runCommand(b.command);
    trail(req, 'minecraft.command', undefined, b.command.slice(0, 200));
    return { output };
  });

  /* ---------------------------------------------------------------- uptime */

  app.get('/api/uptime', async () => listChecks());

  app.post('/api/uptime', { preHandler: requireRole('admin') }, async (req) => {
    const check = createCheck(bodyOf(req));
    trail(req, 'uptime.create', check.name);
    return check;
  });

  app.delete('/api/uptime/:id', { preHandler: requireRole('admin') }, async (req) => {
    deleteCheck((req.params as { id: string }).id);
    trail(req, 'uptime.delete', (req.params as { id: string }).id);
    return { ok: true };
  });

  app.patch('/api/uptime/:id', { preHandler: requireRole('admin') }, async (req) => {
    const b = bodyOf<{ enabled: boolean }>(req);
    setCheckEnabled((req.params as { id: string }).id, Boolean(b.enabled));
    return { ok: true };
  });

  /* ------------------------------------------------------------------ jobs */

  app.get('/api/jobs', async () => listJobs());

  app.get('/api/jobs/:id/runs', async (req) => listRuns((req.params as { id: string }).id));

  app.post('/api/jobs/:id/run', { preHandler: requireRole('admin') }, async (req) => {
    const id = (req.params as { id: string }).id;
    trail(req, 'job.run', id);
    return runJob(id, 'manual');
  });

  app.patch('/api/jobs/:id', { preHandler: requireRole('admin') }, async (req) => {
    const b = bodyOf<{ enabled: boolean }>(req);
    setJobEnabled((req.params as { id: string }).id, Boolean(b.enabled));
    return { ok: true };
  });

  /* -------------------------------------------------------------- settings */

  app.get('/api/settings', async () => {
    const { rcloneVersion } = await import('../storage/transfers.js');
    return {
      mounts: config.mounts.map((m) => ({
        id: m.id,
        label: m.label,
        mountpoint: m.mountpoint,
        tier: m.tier,
      })),
      network: {
        iface: config.network.iface,
        allowanceBytes: config.network.monthlyAllowanceBytes,
        linkSpeedMbps: config.network.linkSpeedMbps,
      },
      integrations: {
        jellyfin: config.jellyfin.enabled,
        minecraft: config.minecraft.enabled,
        docker: supervisor.isAvailable(),
        rclone: await rcloneVersion(),
      },
      security: {
        stepUpWindowSec: config.security.stepUpWindowSec,
        requireStepUp: config.security.requireStepUp,
        sessionTtlDays: config.sessionTtlDays,
      },
      origin: config.origin,
    };
  });
}

export { notFound };
