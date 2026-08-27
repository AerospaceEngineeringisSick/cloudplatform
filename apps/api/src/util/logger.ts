type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(extra === undefined ? `${line}\n` : `${line} ${format(extra)}\n`);
}

function format(extra: unknown): string {
  if (extra instanceof Error) return `${extra.message}\n${extra.stack ?? ''}`;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
