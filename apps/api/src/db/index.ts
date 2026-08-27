import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

const log = logger('db');

export type DB = Database.Database;

let instance: DB | null = null;

export function db(): DB {
  if (!instance) throw new Error('Database not initialised — call openDatabase() first');
  return instance;
}

export function openDatabase(path?: string): DB {
  mkdirSync(config.dataDir, { recursive: true });
  const file = path ?? join(config.dataDir, 'cloud.db');
  const conn = new Database(file);

  // WAL keeps the metrics writer from blocking dashboard reads.
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');

  migrate(conn);
  instance = conn;
  log.info(`opened ${file}`);
  return conn;
}

export function closeDatabase(): void {
  instance?.close();
  instance = null;
}

/**
 * Migrations are append-only. Each entry runs once, inside a transaction,
 * and the applied version is recorded in `schema_version`.
 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name   TEXT NOT NULL,
        password_hash  TEXT NOT NULL,
        role           TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
        totp_secret    TEXT,
        totp_enrolled  INTEGER NOT NULL DEFAULT 0,
        totp_last_step INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        last_login_at  INTEGER
      );

      CREATE TABLE recovery_codes (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at   INTEGER
      );
      CREATE INDEX idx_recovery_user ON recovery_codes(user_id);

      CREATE TABLE passkeys (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key     BLOB NOT NULL,
        counter        INTEGER NOT NULL DEFAULT 0,
        transports     TEXT,
        label          TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_used_at   INTEGER
      );
      CREATE INDEX idx_passkeys_user ON passkeys(user_id);

      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,
        token_hash    TEXT NOT NULL UNIQUE,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        stepped_up_at INTEGER,
        ip            TEXT NOT NULL DEFAULT '',
        user_agent    TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

      CREATE TABLE login_attempts (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        key      TEXT NOT NULL,
        at       INTEGER NOT NULL,
        ok       INTEGER NOT NULL
      );
      CREATE INDEX idx_attempts_key_at ON login_attempts(key, at);

      CREATE TABLE audit_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       INTEGER NOT NULL,
        user_id  TEXT,
        username TEXT,
        action   TEXT NOT NULL,
        target   TEXT,
        ip       TEXT,
        outcome  TEXT NOT NULL CHECK (outcome IN ('ok','denied','error')),
        detail   TEXT
      );
      CREATE INDEX idx_audit_at ON audit_log(at DESC);
    `,
  },
  {
    version: 2,
    sql: `
      -- Fine-grained samples, pruned after config.metrics.retentionHours.
      CREATE TABLE metric_samples (
        at         INTEGER NOT NULL,
        metric     TEXT NOT NULL,
        value      REAL NOT NULL,
        PRIMARY KEY (metric, at)
      ) WITHOUT ROWID;

      -- Hourly rollups, kept for the 30-day views.
      CREATE TABLE metric_rollups (
        hour       INTEGER NOT NULL,
        metric     TEXT NOT NULL,
        avg_value  REAL NOT NULL,
        max_value  REAL NOT NULL,
        min_value  REAL NOT NULL,
        samples    INTEGER NOT NULL,
        PRIMARY KEY (metric, hour)
      ) WITHOUT ROWID;

      -- Monthly network totals for the 80 TB allowance counter.
      CREATE TABLE network_usage (
        month     TEXT PRIMARY KEY,
        rx_bytes  INTEGER NOT NULL DEFAULT 0,
        tx_bytes  INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE uptime_checks (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('http','tcp','container','mount')),
        target      TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE uptime_results (
        check_id   TEXT NOT NULL REFERENCES uptime_checks(id) ON DELETE CASCADE,
        at         INTEGER NOT NULL,
        up         INTEGER NOT NULL,
        latency_ms REAL,
        error      TEXT,
        PRIMARY KEY (check_id, at)
      ) WITHOUT ROWID;

      -- One row per check per day, so 30-day bars stay cheap to query.
      CREATE TABLE uptime_daily (
        check_id   TEXT NOT NULL REFERENCES uptime_checks(id) ON DELETE CASCADE,
        day        TEXT NOT NULL,
        up_count   INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (check_id, day)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE job_state (
        id           TEXT PRIMARY KEY,
        enabled      INTEGER NOT NULL DEFAULT 1,
        last_run_at  INTEGER,
        last_duration_ms INTEGER,
        last_error   TEXT
      );

      CREATE TABLE job_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT NOT NULL,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        ok          INTEGER,
        output      TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_job_runs_job ON job_runs(job_id, started_at DESC);

      -- Arbitrary key/value settings: active profile, custom limits, tiering rules.
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    sql: `
      -- Access bookkeeping that drives automatic hot/warm/cold tiering.
      CREATE TABLE file_access (
        path            TEXT PRIMARY KEY,
        size_bytes      INTEGER NOT NULL,
        last_access_at  INTEGER NOT NULL,
        tier            TEXT NOT NULL,
        pinned          INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_file_access_tier ON file_access(tier, last_access_at);
    `,
  },
];

function migrate(conn: DB): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
  const current =
    (
      conn.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
        | { v: number | null }
        | undefined
    )?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const run = conn.transaction(() => {
      conn.exec(m.sql);
      conn.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    });
    run();
    log.info(`applied migration ${m.version}`);
  }
}

/* ------------------------------------------------------------- settings */

export function getSetting<T>(key: string, fallback: T): T {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), Date.now());
}
