import type { FastifyInstance } from 'fastify';
import type { WsServerMessage, WsClientMessage } from '@cloud/shared';
import { collector } from '../metrics/collector.js';
import { supervisor } from '../docker/supervisor.js';
import { monitor } from '../services/uptime.js';
import { subscribeJobs, listJobs } from '../jobs/scheduler.js';
import { currentState } from '../profiles/engine.js';
import { loadSession } from '../auth/guard.js';
import { logger } from '../util/logger.js';

const log = logger('ws');

type Client = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  channels: Set<string>;
  alive: boolean;
};

const clients = new Set<Client>();

function broadcast(message: WsServerMessage, channel: string): void {
  if (clients.size === 0) return;
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (!client.channels.has(channel)) continue;
    try {
      client.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}

/** Push a one-off notice to every connected dashboard. */
export function notify(level: 'info' | 'warn' | 'error', text: string): void {
  broadcast({ type: 'notice', data: { level, text } }, 'notice');
}

const ALL_CHANNELS = ['host', 'containers', 'profile', 'transfers', 'uptime', 'jobs', 'notice'];

export async function websocketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/live', { websocket: true }, async (socket, req) => {
    // The upgrade carries the session cookie; anonymous sockets are refused
    // rather than silently receiving an empty stream.
    await loadSession(req);
    if (!req.auth) {
      socket.close(4401, 'unauthorized');
      return;
    }

    const client: Client = {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      // Everything is on by default; a client can narrow this if it wants.
      channels: new Set(ALL_CHANNELS),
      alive: true,
    };
    clients.add(client);
    log.debug(`client connected (${clients.size} total)`);

    // Send the current state immediately so the UI paints without waiting.
    const snapshot = collector.snapshot();
    if (snapshot) client.send(JSON.stringify({ type: 'host', data: snapshot }));
    client.send(JSON.stringify({ type: 'containers', data: supervisor.containers() }));
    client.send(JSON.stringify({ type: 'profile', data: currentState() }));
    client.send(JSON.stringify({ type: 'jobs', data: listJobs() }));

    socket.on('message', (raw: Buffer) => {
      let message: WsClientMessage;
      try {
        message = JSON.parse(raw.toString('utf8')) as WsClientMessage;
      } catch {
        return;
      }
      if (message.type === 'subscribe' && Array.isArray(message.channels)) {
        client.channels = new Set(
          message.channels.filter((c) => ALL_CHANNELS.includes(c)).slice(0, ALL_CHANNELS.length),
        );
      }
    });

    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('close', () => {
      clients.delete(client);
      log.debug(`client disconnected (${clients.size} remaining)`);
    });

    socket.on('error', () => clients.delete(client));

    // Drop sockets that stop answering, so dead tabs do not accumulate.
    const heartbeat = setInterval(() => {
      if (!client.alive) {
        clients.delete(client);
        clearInterval(heartbeat);
        try {
          socket.terminate();
        } catch {
          // Already gone.
        }
        return;
      }
      client.alive = false;
      try {
        socket.ping();
      } catch {
        clients.delete(client);
        clearInterval(heartbeat);
      }
    }, 30_000);
    heartbeat.unref();
  });
}

/** Wire the live sources to the socket. Called once at boot. */
export function startBroadcasting(): void {
  collector.subscribe((snapshot) => broadcast({ type: 'host', data: snapshot }, 'host'));

  supervisor.subscribe((containers) =>
    broadcast({ type: 'containers', data: containers }, 'containers'),
  );

  monitor.subscribe((checks) => broadcast({ type: 'uptime', data: checks }, 'uptime'));

  subscribeJobs((jobs) => broadcast({ type: 'jobs', data: jobs }, 'jobs'));

  // Transfers change quickly while running but have no event source of their
  // own, so they are polled and only sent when something is in flight.
  let lastTransferPayload = '';
  setInterval(() => {
    void (async () => {
      const { listTransfers } = await import('../storage/transfers.js');
      const transfers = listTransfers();
      const payload = JSON.stringify(transfers);
      if (payload === lastTransferPayload) return;
      lastTransferPayload = payload;
      broadcast({ type: 'transfers', data: transfers }, 'transfers');
    })();
  }, 1000).unref();

  // The profile rarely changes; a slow poll keeps every tab in step after an
  // automatic switch.
  let lastProfilePayload = '';
  setInterval(() => {
    const state = currentState();
    const payload = JSON.stringify(state);
    if (payload === lastProfilePayload) return;
    lastProfilePayload = payload;
    broadcast({ type: 'profile', data: state }, 'profile');
  }, 2000).unref();
}

export function connectedClients(): number {
  return clients.size;
}
