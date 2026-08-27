import { Link } from 'react-router-dom';
import { useLive, useLiveSeries } from '../lib/live';
import { Panel, StatTile, Loading, InfoNote } from '../components/ui';
import { Gauge, Sparkline, Meter, UptimeBars, CoreBars } from '../components/charts';
import {
  bytes, bitsPerSecond, percent, cores, duration, relativeTime, count, severityFor,
} from '../lib/format';

export function OverviewPage() {
  const { host, containers, uptime, profile } = useLive();

  const cpuSeries = useLiveSeries((h) => h.cpu.usage);
  const memSeries = useLiveSeries((h) =>
    h.memory.totalBytes ? h.memory.usedBytes / h.memory.totalBytes : 0,
  );
  const rxSeries = useLiveSeries((h) => h.network.rxBytesPerSec);
  const txSeries = useLiveSeries((h) => h.network.txBytesPerSec);

  if (!host) {
    return (
      <div className="page">
        <Loading label="Waiting for the first telemetry sample…" />
      </div>
    );
  }

  const memRatio = host.memory.totalBytes ? host.memory.usedBytes / host.memory.totalBytes : 0;
  const running = containers.filter((c) => c.state === 'running');
  const unhealthy = containers.filter((c) => c.health === 'unhealthy');
  const down = uptime.filter((c) => c.enabled && !c.up);
  const offlineMounts = host.disks.filter((d) => !d.online);
  const allowanceUsed =
    host.network.monthAllowanceBytes > 0
      ? (host.network.monthRxBytes + host.network.monthTxBytes) / host.network.monthAllowanceBytes
      : 0;

  const healthy = down.length === 0 && unhealthy.length === 0 && offlineMounts.length === 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-subtitle">
            {host.hostname} · up {duration(host.uptimeSec)} · {running.length} of{' '}
            {containers.length} services running
          </p>
        </div>
        <span className={`badge ${healthy ? 'badge-good' : 'badge-warning'}`}>
          <span className={`dot ${healthy ? 'dot-good' : 'dot-warning'}`} />
          {healthy
            ? 'All critical services healthy'
            : `${down.length + unhealthy.length + offlineMounts.length} need attention`}
        </span>
      </div>

      {!healthy && (
        <div style={{ marginBottom: 16 }}>
          <InfoNote>
            {offlineMounts.length > 0 && (
              <div>
                <strong>Storage offline:</strong>{' '}
                {offlineMounts.map((m) => m.label).join(', ')} — remote mounts drop when the
                SFTP connection is interrupted. Check the Storage page.
              </div>
            )}
            {down.length > 0 && (
              <div>
                <strong>Checks failing:</strong> {down.map((c) => c.name).join(', ')}
              </div>
            )}
            {unhealthy.length > 0 && (
              <div>
                <strong>Containers unhealthy:</strong> {unhealthy.map((c) => c.name).join(', ')}
              </div>
            )}
          </InfoNote>
        </div>
      )}

      {/* Live gauges. Each shows its real reading as text, not colour alone. */}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Panel title="Processor">
          <div style={{ display: 'grid', placeItems: 'center' }}>
            <Gauge
              value={host.cpu.usage}
              label={`${cores(host.cpu.usage * host.cpu.cores, 2)} of ${host.cpu.cores} cores`}
              display={percent(host.cpu.usage)}
              caption={`load ${host.cpu.loadAvg[0].toFixed(2)}`}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <Sparkline
              data={cpuSeries}
              max={1}
              color="var(--series-1)"
              format={(v) => percent(v, 1)}
              label="CPU"
            />
          </div>
        </Panel>

        <Panel title="Memory">
          <div style={{ display: 'grid', placeItems: 'center' }}>
            <Gauge
              value={memRatio}
              label={`${bytes(host.memory.usedBytes)} of ${bytes(host.memory.totalBytes, 0)}`}
              display={percent(memRatio)}
              caption={`${bytes(host.memory.cachedBytes, 0)} cached`}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <Sparkline
              data={memSeries}
              max={1}
              color="var(--series-3)"
              format={(v) => percent(v, 1)}
              label="Memory"
            />
          </div>
        </Panel>

        <Panel title="Storage tiers">
          <div className="stack" style={{ gap: 16 }}>
            {host.disks.map((disk) => (
              <Meter
                key={disk.id}
                label={disk.label}
                value={disk.usedBytes}
                total={disk.totalBytes}
                right={
                  disk.online ? undefined : (
                    <span className="badge badge-critical">
                      <span className="dot dot-critical" />
                      Offline
                    </span>
                  )
                }
              />
            ))}
          </div>
        </Panel>

        <Panel title="Network">
          <div className="stack" style={{ gap: 14 }}>
            <div>
              <div className="metric-label">Down / up right now</div>
              <div className="metric-value tabular" style={{ fontSize: 22, marginTop: 2 }}>
                {bitsPerSecond(host.network.rxBytesPerSec)}
              </div>
              <div className="small secondary tabular">
                ↑ {bitsPerSecond(host.network.txBytesPerSec)}
              </div>
            </div>
            <Sparkline
              data={rxSeries}
              color="var(--series-1)"
              height={34}
              format={bitsPerSecond}
              label="Download"
            />
            <Sparkline
              data={txSeries}
              color="var(--series-2)"
              height={34}
              format={bitsPerSecond}
              label="Upload"
            />
            {/* Two series share this card, so both are named in text. */}
            <div className="row" style={{ gap: 14, fontSize: 11.5 }}>
              <span className="row" style={{ gap: 5 }}>
                <span style={{ width: 9, height: 3, borderRadius: 2, background: 'var(--series-1)' }} />
                <span className="muted">Download</span>
              </span>
              <span className="row" style={{ gap: 5 }}>
                <span style={{ width: 9, height: 3, borderRadius: 2, background: 'var(--series-2)' }} />
                <span className="muted">Upload</span>
              </span>
            </div>
          </div>
        </Panel>
      </div>

      {/* Headline numbers. */}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatTile
          label="Monthly transfer"
          value={bytes(host.network.monthRxBytes + host.network.monthTxBytes, 1)}
          caption={`of ${bytes(host.network.monthAllowanceBytes, 0)} allowance · ${percent(allowanceUsed, 1)} used`}
          tone={severityFor(allowanceUsed, 0.8, 0.95) === 'good' ? undefined : severityFor(allowanceUsed, 0.8, 0.95)}
        />
        <StatTile
          label="Load average"
          value={host.cpu.loadAvg.map((l) => l.toFixed(2)).join('  ')}
          caption="1 · 5 · 15 minutes"
        />
        <StatTile
          label="Containers"
          value={`${running.length} / ${containers.length}`}
          caption={unhealthy.length > 0 ? `${unhealthy.length} unhealthy` : 'all healthy'}
          tone={unhealthy.length > 0 ? 'warning' : undefined}
        />
        <StatTile
          label="Temperature"
          value={host.cpu.tempC !== null ? host.cpu.tempC.toFixed(1) : '—'}
          unit={host.cpu.tempC !== null ? '°C' : undefined}
          caption={host.cpu.tempC === null ? 'not exposed by this VPS' : 'package sensor'}
        />
      </div>

      <div className="grid grid-2">
        <Panel
          title="Per-core utilisation"
          action={<span className="small muted">{host.cpu.cores} vCPU</span>}
        >
          <CoreBars perCore={host.cpu.perCore} />
          <p className="small muted" style={{ marginTop: 12 }}>
            Minecraft and Jellyfin transcoding are both largely single-thread bound. One core
            pinned while the rest idle is normal and healthy.
          </p>
        </Panel>

        <Panel
          title="Service availability"
          action={<Link to="/monitoring" className="small">Details</Link>}
        >
          {uptime.length === 0 ? (
            <div className="empty">No checks configured yet.</div>
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              {uptime.slice(0, 6).map((check) => (
                <div key={check.id}>
                  <div className="row-between" style={{ marginBottom: 5 }}>
                    <span className="row" style={{ gap: 7 }}>
                      <span className={`dot ${check.up ? 'dot-good' : 'dot-critical'}`} />
                      <span style={{ fontSize: 13, fontWeight: 540 }}>{check.name}</span>
                    </span>
                    <span className="small tabular muted">
                      {check.enabled ? percent(check.uptime30d, 2) : 'paused'}
                    </span>
                  </div>
                  <UptimeBars history={check.history} />
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Panel title="Busiest containers" action={<Link to="/containers" className="small">All containers</Link>}>
          {running.length === 0 ? (
            <div className="empty">Nothing is running.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th className="num">CPU</th>
                    <th className="num">Memory</th>
                  </tr>
                </thead>
                <tbody>
                  {[...running]
                    .sort((a, b) => (b.cpuUsage ?? 0) - (a.cpuUsage ?? 0))
                    .slice(0, 6)
                    .map((container) => (
                      <tr key={container.id}>
                        <td>
                          <span className="row" style={{ gap: 7 }}>
                            <span className="dot dot-good" />
                            {container.name}
                          </span>
                        </td>
                        <td className="num tabular">{cores(container.cpuUsage, 2)}</td>
                        <td className="num tabular">{bytes(container.memUsedBytes)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Right now">
          <div className="stack">
            <Row label="Active profile" value={profile ? profile.active : '—'} />
            <Row
              label="Profile set"
              value={
                !profile
                  ? '—'
                  : profile.since === 0
                    ? 'default since startup'
                    : `${profile.appliedBy === 'auto' ? 'automatically' : 'by hand'} ${relativeTime(profile.since)}`
              }
            />
            <Row label="Kernel" value={host.kernel} />
            <Row label="Swap used" value={bytes(host.memory.swapUsedBytes)} />
            <Row label="Processes tracked" value={count(containers.length)} />
            <Row
              label="Link speed"
              value={host.network.linkSpeedMbps ? `${host.network.linkSpeedMbps / 1000} Gbps` : '—'}
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between" style={{ fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span className="tabular" style={{ textAlign: 'right', maxWidth: '60%' }}>
        {value}
      </span>
    </div>
  );
}
