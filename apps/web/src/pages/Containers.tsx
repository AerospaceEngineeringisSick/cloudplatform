import { useState } from 'react';
import type { ContainerSummary } from '@cloud/shared';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { Panel, Modal, Loading, ErrorNote, useConfirm, useAsync } from '../components/ui';
import { bytes, cores, bitsPerSecond, relativeTime, dateTime } from '../lib/format';

const STATE_TONE: Record<string, string> = {
  running: 'badge-good',
  exited: '',
  created: '',
  paused: 'badge-warning',
  restarting: 'badge-warning',
  removing: 'badge-warning',
  dead: 'badge-critical',
};

export function ContainersPage() {
  const { containers } = useLive();
  const [selected, setSelected] = useState<ContainerSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const { dialog, confirm } = useConfirm();

  const act = async (
    container: ContainerSummary,
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> => {
    if (action !== 'start') {
      const ok = await confirm({
        title: `${action === 'stop' ? 'Stop' : 'Restart'} ${container.name}?`,
        body:
          action === 'stop'
            ? 'The service will become unavailable until it is started again.'
            : 'The service will be briefly unavailable while it restarts.',
        danger: action === 'stop',
        confirmLabel: action === 'stop' ? 'Stop' : 'Restart',
      });
      if (!ok) return;
    }
    setBusy(container.id);
    setError('');
    try {
      await api.containerAction(container.id, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} ${container.name}.`);
    } finally {
      setBusy(null);
    }
  };

  const visible = containers.filter(
    (c) =>
      filter === '' ||
      c.name.toLowerCase().includes(filter.toLowerCase()) ||
      c.image.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="page">
      {dialog}
      <div className="page-head">
        <div>
          <h1 className="page-title">Containers</h1>
          <p className="page-subtitle">
            Every workload on the machine, with live CPU and memory drawn straight from the
            Docker API.
          </p>
        </div>
        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder="Filter by name or image…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter containers"
        />
      </div>

      <ErrorNote>{error}</ErrorNote>

      <Panel bodyClass="flush">
        {containers.length === 0 ? (
          <div className="empty">
            No containers found. If Docker is running, check that the dashboard can reach
            <code className="mono"> /var/run/docker.sock</code>.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>State</th>
                  <th>Image</th>
                  <th className="num">CPU</th>
                  <th className="num">Memory</th>
                  <th className="num">Network</th>
                  <th style={{ width: 1 }} />
                </tr>
              </thead>
              <tbody>
                {visible.map((container) => (
                  <tr key={container.id}>
                    <td>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ padding: 0, fontWeight: 560 }}
                        onClick={() => setSelected(container)}
                      >
                        {container.name}
                      </button>
                      {container.serviceKey && (
                        <div className="metric-label" style={{ fontSize: 10.5 }}>
                          {container.serviceKey}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${STATE_TONE[container.state] ?? ''}`}>
                        <span
                          className={`dot ${container.state === 'running' ? 'dot-good' : container.state === 'dead' ? 'dot-critical' : ''}`}
                        />
                        {container.state}
                      </span>
                      {container.health !== 'none' && (
                        <div className="metric-label" style={{ fontSize: 10.5, marginTop: 3 }}>
                          {container.health}
                        </div>
                      )}
                    </td>
                    <td className="mono muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {container.image}
                    </td>
                    <td className="num tabular">{cores(container.cpuUsage, 2)}</td>
                    <td className="num tabular">
                      {bytes(container.memUsedBytes)}
                      {container.memLimitBytes ? (
                        <div className="metric-label" style={{ fontSize: 10.5 }}>
                          of {bytes(container.memLimitBytes, 0)}
                        </div>
                      ) : null}
                    </td>
                    <td className="num tabular small muted">
                      {container.state === 'running' ? (
                        <>
                          ↓ {bitsPerSecond(container.netRxBytesPerSec)}
                          <br />↑ {bitsPerSecond(container.netTxBytesPerSec)}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <div className="btn-row nowrap">
                        {container.state === 'running' ? (
                          <>
                            <button
                              className="btn btn-sm"
                              onClick={() => void act(container, 'restart')}
                              disabled={busy === container.id}
                            >
                              Restart
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => void act(container, 'stop')}
                              disabled={busy === container.id}
                            >
                              Stop
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => void act(container, 'start')}
                            disabled={busy === container.id}
                          >
                            Start
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <ContainerDetail container={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/* -------------------------------------------------------------- detail -- */

function ContainerDetail({
  container, onClose,
}: {
  container: ContainerSummary | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'info' | 'logs'>('info');

  return (
    <Modal
      open={container !== null}
      title={container?.name ?? ''}
      onClose={onClose}
      width={720}
    >
      {container && (
        <>
          <div className="btn-row" style={{ marginBottom: 16 }}>
            <button
              className={`btn btn-sm ${tab === 'info' ? 'btn-primary' : ''}`}
              onClick={() => setTab('info')}
            >
              Details
            </button>
            <button
              className={`btn btn-sm ${tab === 'logs' ? 'btn-primary' : ''}`}
              onClick={() => setTab('logs')}
            >
              Logs
            </button>
          </div>

          {tab === 'info' ? <DetailBody id={container.id} /> : <LogsBody id={container.id} />}
        </>
      )}
    </Modal>
  );
}

function DetailBody({ id }: { id: string }) {
  const { data, error, loading } = useAsync(() => api.container(id), [id]);

  if (loading) return <Loading />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return null;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div>
        <h3 className="panel-title" style={{ marginBottom: 8 }}>Resource limits</h3>
        <div className="stack" style={{ gap: 6 }}>
          <Row label="CPU ceiling" value={data.limits.cpus !== null ? `${data.limits.cpus} cores` : 'unlimited'} />
          <Row label="Memory ceiling" value={data.limits.memoryBytes !== null ? bytes(data.limits.memoryBytes, 1) : 'unlimited'} />
          <Row
            label="Memory reservation"
            value={data.limits.memoryReservationBytes !== null ? bytes(data.limits.memoryReservationBytes, 1) : 'none'}
          />
          <Row label="CPU shares" value={data.limits.cpuShares !== null ? String(data.limits.cpuShares) : 'default'} />
        </div>
      </div>

      <div>
        <h3 className="panel-title" style={{ marginBottom: 8 }}>Runtime</h3>
        <div className="stack" style={{ gap: 6 }}>
          <Row label="Image" value={data.summary.image} />
          <Row label="Created" value={dateTime(data.summary.createdAt)} />
          <Row label="Started" value={data.summary.startedAt ? relativeTime(data.summary.startedAt) : 'not running'} />
          <Row label="Restarts" value={String(data.summary.restartCount)} />
          <Row label="Health" value={data.summary.health} />
        </div>
      </div>

      {data.summary.ports.length > 0 && (
        <div>
          <h3 className="panel-title" style={{ marginBottom: 8 }}>Ports</h3>
          <div className="stack" style={{ gap: 6 }}>
            {data.summary.ports.map((p, i) => (
              <Row
                key={i}
                label={`${p.container}/${p.protocol}`}
                value={p.host ? `published on ${p.host}` : 'internal only'}
              />
            ))}
          </div>
        </div>
      )}

      {data.mounts.length > 0 && (
        <div>
          <h3 className="panel-title" style={{ marginBottom: 8 }}>Mounts</h3>
          <div className="stack" style={{ gap: 6 }}>
            {data.mounts.map((m, i) => (
              <Row key={i} label={m.destination} value={`${m.source} (${m.mode})`} />
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="panel-title" style={{ marginBottom: 8 }}>
          Environment
          <span className="muted" style={{ textTransform: 'none', fontWeight: 400 }}>
            {' '}— secrets are redacted by the server
          </span>
        </h3>
        <div className="log-view" style={{ maxHeight: 200 }}>
          {data.env.join('\n') || 'none'}
        </div>
      </div>
    </div>
  );
}

function LogsBody({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync(() => api.containerLogs(id, 400), [id]);

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="small muted">Last 400 lines</span>
        <button className="btn btn-sm" onClick={reload} disabled={loading}>
          {loading ? <span className="spinner" /> : 'Refresh'}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading ? <Loading /> : <div className="log-view">{data?.logs || 'No output.'}</div>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between small" style={{ gap: 16 }}>
      <span className="muted nowrap">{label}</span>
      <span className="mono" style={{ textAlign: 'right', wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  );
}
