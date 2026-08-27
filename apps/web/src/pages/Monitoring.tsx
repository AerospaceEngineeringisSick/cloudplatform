import { useEffect, useState } from 'react';
import type { HistoryMetric, HistoryRange, HistorySeries } from '@cloud/shared';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import {
  Panel, Modal, Loading, ErrorNote, useConfirm, Toggle, InfoNote,
} from '../components/ui';
import { AreaChart, UptimeBars } from '../components/charts';
import { bytes, bitsPerSecond, percent, relativeTime } from '../lib/format';

const RANGES: HistoryRange[] = ['1h', '24h', '7d', '30d'];
const RANGE_LABEL: Record<HistoryRange, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

export function MonitoringPage() {
  const { uptime } = useLive();
  const [range, setRange] = useState<HistoryRange>('24h');
  const [series, setSeries] = useState<Record<string, HistorySeries>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const { dialog, confirm } = useConfirm();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const metrics: HistoryMetric[] = ['cpu', 'memory', 'net_rx', 'net_tx', 'disk_read', 'disk_write'];
    Promise.all(metrics.map((m) => api.history(m, range)))
      .then((results) => {
        if (!alive) return;
        const next: Record<string, HistorySeries> = {};
        results.forEach((r) => {
          next[r.metric] = r;
        });
        setSeries(next);
        setError('');
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load history.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [range]);

  const removeCheck = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete the "${name}" check?`,
      body: 'Its history is deleted too. This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete check',
    });
    if (!ok) return;
    try {
      await api.deleteCheck(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that check.');
    }
  };

  return (
    <div className="page">
      {dialog}
      <div className="page-head">
        <div>
          <h1 className="page-title">Monitoring</h1>
          <p className="page-subtitle">
            Host history and service availability. Samples are stored every 30 seconds and
            folded into hourly rollups for the longer views.
          </p>
        </div>
        <div className="btn-row" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r}
              className={`btn btn-sm ${range === r ? 'btn-primary' : ''}`}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {loading ? (
        <Loading label="Loading history…" />
      ) : (
        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          <Panel title={`Processor — ${RANGE_LABEL[range]}`}>
            <AreaChart
              series={[
                { name: 'CPU', color: 'var(--series-1)', data: series.cpu?.points ?? [] },
              ]}
              max={1}
              format={(v) => percent(v, 0)}
            />
          </Panel>

          <Panel title={`Memory — ${RANGE_LABEL[range]}`}>
            <AreaChart
              series={[
                { name: 'Memory', color: 'var(--series-3)', data: series.memory?.points ?? [] },
              ]}
              max={1}
              format={(v) => percent(v, 0)}
            />
          </Panel>

          <Panel title={`Network — ${RANGE_LABEL[range]}`}>
            {/* Both series are bytes per second, so they share one scale. */}
            <AreaChart
              series={[
                { name: 'Download', color: 'var(--series-1)', data: series.net_rx?.points ?? [] },
                { name: 'Upload', color: 'var(--series-2)', data: series.net_tx?.points ?? [] },
              ]}
              format={bitsPerSecond}
            />
          </Panel>

          <Panel title={`Disk throughput — ${RANGE_LABEL[range]}`}>
            <AreaChart
              series={[
                { name: 'Read', color: 'var(--series-3)', data: series.disk_read?.points ?? [] },
                { name: 'Write', color: 'var(--series-4)', data: series.disk_write?.points ?? [] },
              ]}
              format={(v) => `${bytes(v, 0)}/s`}
            />
          </Panel>
        </div>
      )}

      <Panel
        title="Availability checks"
        action={
          <button className="btn btn-sm" onClick={() => setAdding(true)}>
            Add check
          </button>
        }
      >
        {uptime.length === 0 ? (
          <div className="empty">No checks configured.</div>
        ) : (
          <div className="stack" style={{ gap: 20 }}>
            {uptime.map((check) => (
              <div key={check.id}>
                <div className="row-between" style={{ marginBottom: 7 }}>
                  <div className="row" style={{ gap: 9 }}>
                    <span
                      className={`dot ${check.enabled ? (check.up ? 'dot-good' : 'dot-critical') : ''}`}
                    />
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 550 }}>{check.name}</div>
                      <div className="metric-label mono" style={{ fontSize: 10.5 }}>
                        {check.kind} · {check.target}
                      </div>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 14 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div className="small tabular" style={{ fontWeight: 560 }}>
                        {percent(check.uptime30d, 2)}
                      </div>
                      <div className="metric-label" style={{ fontSize: 10.5 }}>
                        30-day uptime
                      </div>
                    </div>
                    <Toggle
                      checked={check.enabled}
                      label=""
                      onChange={(next) => void api.setCheckEnabled(check.id, next).catch(() => undefined)}
                    />
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => void removeCheck(check.id, check.name)}
                      aria-label={`Delete ${check.name}`}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <UptimeBars history={check.history} />
                <div className="row-between metric-label" style={{ marginTop: 5, fontSize: 10.5 }}>
                  <span>30 days ago</span>
                  <span>
                    {check.latencyMs !== null && check.latencyMs > 0
                      ? `${Math.round(check.latencyMs)} ms · `
                      : ''}
                    checked {relativeTime(check.lastCheckedAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <AddCheckDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function AddCheckDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('http');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api.createCheck({ name: name.trim(), kind, target: target.trim() });
      setName('');
      setTarget('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that check.');
    } finally {
      setBusy(false);
    }
  };

  const placeholder =
    kind === 'http'
      ? 'https://media.example.com'
      : kind === 'tcp'
        ? '127.0.0.1:25565'
        : kind === 'container'
          ? 'jellyfin'
          : '/mnt/storagebox';

  return (
    <Modal open={open} title="Add an availability check" onClose={onClose}>
      <ErrorNote>{error}</ErrorNote>
      <div className="field">
        <label className="field-label" htmlFor="check-name">Name</label>
        <input id="check-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="check-kind">Kind</label>
        <select id="check-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="http">HTTP — fetch a URL</option>
          <option value="tcp">TCP — open a port</option>
          <option value="container">Container — must be running and healthy</option>
          <option value="mount">Mount — filesystem must answer</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="check-target">Target</label>
        <input
          id="check-target"
          className="input mono"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={placeholder}
        />
        <span className="field-hint">
          {kind === 'container'
            ? 'The service key from the container’s cloud.service label.'
            : kind === 'mount'
              ? 'A mount point. A hung SFTP mount is exactly what this catches.'
              : kind === 'tcp'
                ? 'host:port'
                : 'A full URL. Any non-5xx response counts as up.'}
        </span>
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !name.trim() || !target.trim()}>
          {busy ? <span className="spinner" /> : 'Add check'}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- jobs -- */

export function JobsPage() {
  const { jobs } = useLive();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<{ jobId: string; output: string } | null>(null);

  const run = async (id: string): Promise<void> => {
    setBusy(id);
    setError('');
    try {
      const result = await api.runJob(id);
      setRuns({ jobId: id, output: result.output || 'Completed with no output.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run that job.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Jobs</h1>
          <p className="page-subtitle">
            Scheduled maintenance. The active resource profile can pause heavy jobs — Gaming
            mode holds backups and the tiering sweep until you stop playing.
          </p>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <Panel bodyClass="flush">
        {jobs.length === 0 ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Schedule</th>
                  <th>Last run</th>
                  <th>Next run</th>
                  <th>State</th>
                  <th style={{ width: 1 }} />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{job.name}</div>
                      <div className="small muted" style={{ maxWidth: 380, lineHeight: 1.45 }}>
                        {job.description}
                      </div>
                    </td>
                    <td className="mono small muted">{job.schedule}</td>
                    <td className="small">
                      {relativeTime(job.lastRunAt)}
                      {job.lastDurationMs !== null && (
                        <div className="metric-label" style={{ fontSize: 10.5 }}>
                          took {(job.lastDurationMs / 1000).toFixed(1)}s
                        </div>
                      )}
                    </td>
                    <td className="small muted">
                      {job.pausedByProfile ? 'paused' : relativeTime(job.nextRunAt)}
                    </td>
                    <td>
                      {job.pausedByProfile ? (
                        <span className="badge badge-warning">Paused by profile</span>
                      ) : job.state === 'running' ? (
                        <span className="badge badge-accent">
                          <span className="spinner" style={{ width: 10, height: 10 }} />
                          Running
                        </span>
                      ) : job.state === 'failed' ? (
                        <span className="badge badge-critical" title={job.lastError ?? ''}>
                          <span className="dot dot-critical" />
                          Failed
                        </span>
                      ) : job.enabled ? (
                        <span className="badge badge-good">
                          <span className="dot dot-good" />
                          Scheduled
                        </span>
                      ) : (
                        <span className="badge">Disabled</span>
                      )}
                    </td>
                    <td>
                      <div className="btn-row nowrap">
                        <Toggle
                          checked={job.enabled}
                          label=""
                          onChange={(next) =>
                            void api.setJobEnabled(job.id, next).catch(() => undefined)
                          }
                        />
                        <button
                          className="btn btn-sm"
                          onClick={() => void run(job.id)}
                          disabled={busy !== '' || job.state === 'running'}
                        >
                          {busy === job.id ? <span className="spinner" /> : 'Run now'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {jobs.some((j) => j.lastError) && (
        <div style={{ marginTop: 16 }}>
          <Panel title="Recent failures">
            <div className="stack" style={{ gap: 10 }}>
              {jobs
                .filter((j) => j.lastError)
                .map((job) => (
                  <div key={job.id}>
                    <div style={{ fontSize: 13, fontWeight: 550 }}>{job.name}</div>
                    <div className="mono small" style={{ color: 'var(--critical)', marginTop: 2 }}>
                      {job.lastError}
                    </div>
                  </div>
                ))}
            </div>
          </Panel>
        </div>
      )}

      <Modal open={runs !== null} title="Job output" onClose={() => setRuns(null)} width={640}>
        <div className="log-view">{runs?.output}</div>
      </Modal>
    </div>
  );
}
