import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { Panel, StatTile, Loading, ErrorNote, InfoNote, useConfirm } from '../components/ui';
import { bytes, cores, relativeTime, duration } from '../lib/format';

interface ConsoleLine {
  id: number;
  kind: 'command' | 'reply' | 'error';
  text: string;
}

let lineSeq = 0;

export function MinecraftPage() {
  const { containers } = useLive();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.minecraft>> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [command, setCommand] = useState('');
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const consoleRef = useRef<HTMLDivElement>(null);
  const { dialog, confirm } = useConfirm();

  const container = containers.find((c) => c.serviceKey === 'minecraft');

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await api.minecraft());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the server status.');
    }
  };

  useEffect(() => {
    void refresh();
    // The world is either off or actively being played; five seconds is plenty.
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [lines]);

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setError('');
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${label}.`);
    } finally {
      setBusy('');
    }
  };

  const sendCommand = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = command.trim();
    if (!trimmed) return;
    setLines((current) => [...current, { id: ++lineSeq, kind: 'command', text: `> ${trimmed}` }]);
    setCommand('');
    try {
      const result = await api.minecraftCommand(trimmed);
      setLines((current) => [
        ...current,
        { id: ++lineSeq, kind: 'reply', text: result.output || '(no output)' },
      ]);
    } catch (err) {
      setLines((current) => [
        ...current,
        {
          id: ++lineSeq,
          kind: 'error',
          text: err instanceof Error ? err.message : 'Command failed.',
        },
      ]);
    }
  };

  if (!status) {
    return (
      <div className="page">
        <Loading label="Reading Minecraft status…" />
      </div>
    );
  }

  const running = container?.state === 'running';
  const players = status.players.length;

  return (
    <div className="page">
      {dialog}
      <div className="page-head">
        <div>
          <h1 className="page-title">Minecraft</h1>
          <p className="page-subtitle">
            Started on demand. Starting the server automatically switches the machine into
            Gaming mode; stopping it hands the resources straight back.
          </p>
        </div>
        <span className={`badge ${running ? 'badge-good' : ''}`}>
          <span className={`dot ${running ? 'dot-good dot-pulse' : ''}`} />
          {running ? 'Online' : 'Offline'}
        </span>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {!container && (
        <div style={{ marginBottom: 16 }}>
          <InfoNote>
            No container labelled <code className="mono">cloud.service=minecraft</code> was
            found. Deploy the games stack with{' '}
            <code className="mono">docker compose -f stack/docker-compose.games.yml up -d</code>{' '}
            to enable this page.
          </InfoNote>
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatTile
          label="Players online"
          value={running ? `${players}${status.maxPlayers ? ` / ${status.maxPlayers}` : ''}` : '—'}
          caption={players > 0 ? status.players.map((p) => p.name).join(', ') : 'nobody connected'}
        />
        <StatTile
          label="Ticks per second"
          value={status.tps !== null ? status.tps.toFixed(2) : '—'}
          caption={
            status.tps === null
              ? 'Paper reports this; vanilla does not'
              : status.tps >= 19.5
                ? 'running smoothly'
                : 'the server is struggling'
          }
          tone={status.tps !== null && status.tps < 19 ? 'warning' : undefined}
        />
        <StatTile
          label="Milliseconds per tick"
          value={status.mspt !== null ? status.mspt.toFixed(1) : '—'}
          unit={status.mspt !== null ? 'ms' : undefined}
          caption="under 50 ms keeps 20 TPS"
          tone={status.mspt !== null && status.mspt > 45 ? 'warning' : undefined}
        />
        <StatTile
          label="World size"
          value={bytes(status.worldBytes, 1)}
          caption={`last backup ${relativeTime(status.lastBackupAt)}`}
        />
      </div>

      <div className="grid grid-2">
        <Panel title="Server control">
          <div className="stack" style={{ gap: 16 }}>
            <div className="btn-row">
              {running ? (
                <>
                  <button
                    className="btn btn-danger"
                    disabled={busy !== ''}
                    onClick={() =>
                      void (async () => {
                        const ok = await confirm({
                          title: 'Stop the Minecraft server?',
                          body: 'The world is saved and flushed first, then players are disconnected. Normal mode is restored automatically.',
                          danger: true,
                          confirmLabel: 'Save and stop',
                        });
                        if (ok) await run('stop the server', api.minecraftStop);
                      })()
                    }
                  >
                    {busy === 'stop the server' ? <span className="spinner" /> : 'Stop server'}
                  </button>
                  <button
                    className="btn"
                    disabled={busy !== ''}
                    onClick={() => void run('restart the server', api.minecraftRestart)}
                  >
                    Restart
                  </button>
                </>
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={busy !== '' || !container}
                  onClick={() => void run('start the server', api.minecraftStart)}
                >
                  {busy === 'start the server' ? <span className="spinner" /> : 'Start server'}
                </button>
              )}
              <button
                className="btn"
                disabled={busy !== '' || !container}
                onClick={() => void run('back up the world', api.minecraftBackup)}
              >
                {busy === 'back up the world' ? <span className="spinner" /> : 'Back up now'}
              </button>
            </div>

            <hr className="divider" style={{ margin: 0 }} />

            <div className="stack" style={{ gap: 7 }}>
              <Row label="Container" value={container ? container.name : 'not deployed'} />
              <Row label="Status" value={container?.status ?? '—'} />
              <Row
                label="CPU ceiling"
                value={status.limits?.cpus !== null && status.limits?.cpus !== undefined ? `${status.limits.cpus} cores` : 'unlimited'}
              />
              <Row
                label="Memory ceiling"
                value={status.limits?.memoryBytes ? bytes(status.limits.memoryBytes, 0) : 'unlimited'}
              />
              <Row label="Live CPU" value={cores(container?.cpuUsage, 2)} />
              <Row label="Live memory" value={bytes(container?.memUsedBytes)} />
              <Row
                label="Uptime"
                value={container?.startedAt ? duration((Date.now() - container.startedAt) / 1000) : '—'}
              />
            </div>

            {status.error && (
              <InfoNote>{status.error}</InfoNote>
            )}
          </div>
        </Panel>

        <Panel title="Console">
          {!running ? (
            <div className="empty">The server is offline. Start it to use the console.</div>
          ) : (
            <>
              <div className="log-view" ref={consoleRef} style={{ maxHeight: 300, minHeight: 220 }}>
                {lines.length === 0
                  ? 'Type a command below. RCON runs it on the live server.'
                  : lines.map((line) => (
                      <div
                        key={line.id}
                        style={{
                          color:
                            line.kind === 'command'
                              ? 'var(--accent)'
                              : line.kind === 'error'
                                ? 'var(--critical)'
                                : undefined,
                        }}
                      >
                        {line.text}
                      </div>
                    ))}
              </div>
              <form onSubmit={sendCommand} className="row" style={{ marginTop: 12, gap: 8 }}>
                <input
                  className="input mono"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="say hello / time set day / whitelist add Ralph"
                  aria-label="Minecraft command"
                />
                <button className="btn btn-primary" disabled={!command.trim()}>
                  Run
                </button>
              </form>
              <p className="small muted" style={{ marginTop: 8 }}>
                <code className="mono">stop</code>, <code className="mono">op</code> and{' '}
                <code className="mono">deop</code> are blocked here — use the buttons and the
                Security page instead.
              </p>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between small">
      <span className="muted">{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}
