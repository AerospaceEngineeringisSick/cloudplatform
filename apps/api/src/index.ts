import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { openDatabase, closeDatabase } from './db/index.js';
import { logger } from './util/logger.js';
import { HttpError } from './util/index.js';
import { loadSession } from './auth/guard.js';
import { authRoutes } from './routes/auth.js';
import { systemRoutes } from './routes/system.js';
import { websocketRoutes, startBroadcasting } from './ws/channel.js';
import { collector } from './metrics/collector.js';
import { supervisor } from './docker/supervisor.js';
import { monitor, seedDefaultChecks } from './services/uptime.js';
import { registerDefaults, startScheduler, stopScheduler } from './jobs/scheduler.js';

const log = logger('server');

async function main(): Promise<void> {
  openDatabase();

  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    // Large enough for a profile definition, small enough to be uninteresting
    // as an amplification target.
    bodyLimit: 1024 * 1024,
  });

  /**
   * Several endpoints are pure commands with no payload. Browsers and clients
   * routinely send `content-type: application/json` with an empty body on
   * those, which Fastify rejects by default; treat it as an empty object.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text === '') return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        done(new HttpError(400, 'bad_json', 'The request body is not valid JSON.'), undefined);
      }
    },
  );

  await app.register(cookie, {
    secret: config.sessionSecret,
    parseOptions: { path: '/' },
  });
  await app.register(websocket);

  /* --------------------------------------------------------- hardening */

  app.addHook('onRequest', async (req, reply) => {
    // The dashboard serves only its own assets and talks only to itself.
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // Vite injects styles at runtime; images include inline QR data URLs.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    );
    if (config.origin.startsWith('https://')) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  /**
   * Cookie-authenticated state changes need CSRF protection. Same-site cookies
   * cover most of it; checking Origin closes the rest without a token dance.
   */
  app.addHook('onRequest', async (req) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    const origin = req.headers.origin;
    if (!origin) return; // Non-browser clients (curl, scripts) send no Origin.
    if (origin !== config.origin) {
      throw new HttpError(403, 'bad_origin', 'Cross-origin request refused.');
    }
  });

  app.addHook('preHandler', loadSession);

  /* ---------------------------------------------------- error handling */

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      const body: Record<string, unknown> = { error: error.code, message: error.message };
      if (typeof error.extra.retryAfterSec === 'number') {
        reply.header('Retry-After', String(error.extra.retryAfterSec));
        body.retryAfterSec = error.extra.retryAfterSec;
      }
      return reply.status(error.status).send(body);
    }

    // Fastify's own validation and parse errors carry a statusCode.
    const status = (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : 'Request could not be processed.';
    if (status && status < 500) {
      return reply.status(status).send({ error: 'bad_request', message });
    }

    // Anything else is a bug: log it in full, tell the client nothing useful.
    log.error(`unhandled error on ${req.method} ${req.url}`, error);
    return reply
      .status(500)
      .send({ error: 'internal', message: 'Something went wrong on the server.' });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not_found', message: 'No such endpoint.' });
    }
    // Everything else is the single-page app's business.
    if (config.serveWeb && existsSync(join(config.webRoot, 'index.html'))) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send({ error: 'not_found', message: 'Not found.' });
  });

  /* -------------------------------------------------------------- routes */

  app.get('/api/health', async () => ({
    ok: true,
    at: Date.now(),
    docker: supervisor.isAvailable(),
    metrics: collector.snapshot() !== null,
  }));

  await app.register(authRoutes);
  await app.register(systemRoutes);
  await app.register(websocketRoutes);

  if (config.serveWeb) {
    if (existsSync(config.webRoot)) {
      await app.register(fastifyStatic, { root: config.webRoot, prefix: '/' });
      log.info(`serving the dashboard from ${config.webRoot}`);
    } else {
      log.warn(`SERVE_WEB is on but ${config.webRoot} does not exist — build the web app first`);
    }
  }

  /* ---------------------------------------------------------- background */

  collector.start();
  await supervisor.start();
  seedDefaultChecks();
  monitor.start();
  registerDefaults();
  startScheduler();
  startBroadcasting();

  await app.listen({ host: config.host, port: config.port });
  log.info(`listening on http://${config.host}:${config.port}`);
  if (config.host === '0.0.0.0') {
    log.warn(
      'HOST is 0.0.0.0 — the control plane is reachable from every interface. ' +
        'Bind it to loopback or your VPN address and let the reverse proxy handle exposure.',
    );
  }

  /* ------------------------------------------------------------ shutdown */

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info(`${signal} received, shutting down`);
    stopScheduler();
    monitor.stop();
    supervisor.stop();
    collector.stop();
    try {
      await app.close();
      closeDatabase();
    } catch (err) {
      log.error('error during shutdown', err);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));
}

main().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});
