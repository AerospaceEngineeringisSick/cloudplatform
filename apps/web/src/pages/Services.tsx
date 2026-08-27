import { useEffect, useState } from 'react';
import type { JellyfinStatus } from '@cloud/shared';
import { api } from '../lib/api';
import { useLive, useLiveSeries } from '../lib/live';
import { Panel, StatTile, Loading, ErrorNote, InfoNote } from '../components/ui';
import { Meter, Sparkline, AreaChart } from '../components/charts';
import { bytes, bitsPerSecond, percent, cores, count, relativeTime } from '../lib/format';

/* --------------------------------------------------------------- media -- */

export function MediaPage() {
  const { containers } = useLive();
  const [status, setStatus] = useState<JellyfinStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const container = containers.find((c) => c.serviceKey === 'jellyfin');

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await api.jellyfin());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read Jellyfin status.');
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    return () => clearInterval(timer);
  }, []);

  const act = async (label: string, action: () => Promise<unknown>): Promise<void> => {
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

  if (!status) {
    return (
      <div className="page">
        <Loading label="Reading Jellyfin status…" />
      </div>
    );
  }

  const transcoding = status.transcodeCount > 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Media</h1>
          <p className="page-subtitle">
            Jellyfin, and the one number that matters on a four-core box: how many streams are
            being transcoded rather than played directly.
          </p>
        </div>
        <span className={`badge ${status.online ? 'badge-good' : ''}`}>
          <span className={`dot ${status.online ? 'dot-good' : ''}`} />
          {status.online ? 'Online' : 'Offline'}
        </span>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {status.error && (
        <div style={{ marginBottom: 16 }}>
          <InfoNote>{status.error}</InfoNote>
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatTile label="Active streams" value={count(status.streams.length)} caption="playing right now" />
        <StatTile
          label="Direct play"
          value={count(status.directPlayCount)}
          caption="no CPU cost — the ideal case"
        />
        <StatTile
          label="Transcoding"
          value={count(status.transcodeCount)}
          caption={transcoding ? 'each one can eat a whole core' : 'nothing being re-encoded'}
          tone={transcoding ? 'warning' : undefined}
        />
        <StatTile
          label="Library items"
          value={status.libraryItemCount !== null ? count(status.libraryItemCount) : '—'}
          caption="movies, series and episodes"
        />
      </div>

      <div className="grid grid-2">
        <Panel
          title="What's playing"
          action={
            <div className="btn-row">
              <button
                className="btn btn-sm"
                disabled={busy !== ''}
                onClick={() => void act('rescan the library', api.jellyfinRescan)}
              >
                {busy === 'rescan the library' ? <span className="spinner" /> : 'Rescan library'}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy !== ''}
                onClick={() => void act('restart Jellyfin', api.jellyfinRestart)}
              >
                Restart
              </button>
            </div>
          }
        >
          {status.streams.length === 0 ? (
            <div className="empty">Nothing is playing.</div>
          ) : (
            <div className="stack" style={{ gap: 16 }}>
              {status.streams.map((stream, index) => (
                <div key={index}>
                  <div className="row-between" style={{ marginBottom: 5 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 550 }}>{stream.item}</span>
                    <span
                      className={`badge ${stream.method === 'Transcode' ? 'badge-warning' : 'badge-good'}`}
                    >
                      {stream.method === 'Transcode'
                        ? 'Transcoding'
                        : stream.method === 'DirectStream'
                          ? 'Direct stream'
                          : 'Direct play'}
                    </span>
                  </div>
                  <div className="small muted" style={{ marginBottom: 6 }}>
                    {stream.user} · {stream.client}
                    {stream.bitrateBps ? ` · ${bitsPerSecond(stream.bitrateBps / 8)}` : ''}
                  </div>
                  <Meter
                    label=""
                    value={stream.progress}
                    total={1}
                    color="var(--accent)"
                    right={<span className="small tabular muted">{percent(stream.progress)}</span>}
                    height={5}
                  />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Resource usage">
          <div className="stack" style={{ gap: 12 }}>
            <Row label="Container" value={container?.name ?? 'not deployed'} />
            <Row label="State" value={container?.status ?? '—'} />
            <Row label="Live CPU" value={cores(container?.cpuUsage, 2)} />
            <Row label="CPU ceiling" value={
              container?.memLimitBytes ? 'set by profile' : 'unlimited'
            } />
            <Row label="Memory" value={bytes(container?.memUsedBytes)} />
            <Row
              label="Memory ceiling"
              value={container?.memLimitBytes ? bytes(container.memLimitBytes, 0) : 'unlimited'}
            />
            <hr className="divider" style={{ margin: '4px 0' }} />
            <InfoNote>
              Direct play costs almost nothing. A single 4K transcode can saturate every core
              you allow it — that is what Media mode is for, and why Gaming mode drops Jellyfin
              to direct play only.
            </InfoNote>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- cloud -- */

export function CloudPage() {
  const { host, containers } = useLive();
  const immich = containers.find((c) => c.serviceKey === 'immich');
  const immichMl = containers.find((c) => c.serviceKey === 'immich-ml');
  const syncthing = containers.find((c) => c.serviceKey === 'syncthing');
  const database = containers.find((c) => c.serviceKey === 'database');
  const remote = host?.disks.find((d) => d.tier === 'remote');
  const hdd = host?.disks.find((d) => d.tier === 'hdd');

  const photosUp = immich?.state === 'running';
  const syncUp = syncthing?.state === 'running';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Cloud</h1>
          <p className="page-subtitle">
            Photos and file sync, split into two focused services rather than one that does
            everything. Browsing arbitrary files is the Storage page's job.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className={`badge ${photosUp ? 'badge-good' : ''}`}>
            <span className={`dot ${photosUp ? 'dot-good' : ''}`} />
            Photos {photosUp ? 'online' : 'offline'}
          </span>
          <span className={`badge ${syncUp ? 'badge-good' : ''}`}>
            <span className={`dot ${syncUp ? 'dot-good' : ''}`} />
            Sync {syncUp ? 'online' : 'offline'}
          </span>
        </div>
      </div>

      {!immich && (
        <div style={{ marginBottom: 16 }}>
          <InfoNote>
            No container labelled <code className="mono">cloud.service=immich</code> was found.
            Deploy it with{' '}
            <code className="mono">docker compose -f stack/docker-compose.cloud.yml up -d</code>.
          </InfoNote>
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatTile
          label="Photo library"
          value={bytes(hdd?.usedBytes, 1)}
          caption={`${bytes(hdd?.freeBytes, 0)} free on the warm tier`}
        />
        <StatTile
          label="Bulk tier"
          value={remote?.online ? bytes(remote.freeBytes, 0) : 'offline'}
          caption="StorageBox — archive and backups"
          tone={remote && !remote.online ? 'critical' : undefined}
        />
        <StatTile
          label="Immich memory"
          value={bytes(immich?.memUsedBytes)}
          caption={immich?.memLimitBytes ? `ceiling ${bytes(immich.memLimitBytes, 0)}` : 'unlimited'}
        />
        <StatTile
          label="Photo analysis"
          value={immichMl?.state === 'running' ? 'Running' : 'Paused'}
          caption={
            immichMl?.state === 'running'
              ? `using ${cores(immichMl.cpuUsage, 2)} cores`
              : 'uploads continue; analysis resumes later'
          }
        />
      </div>

      <div className="grid grid-2">
        <Panel title="Immich — photos and video">
          <div className="stack" style={{ gap: 12 }}>
            <Row label="Server" value={immich?.status ?? 'not deployed'} />
            <Row label="Analysis worker" value={immichMl?.status ?? 'not deployed'} />
            <Row label="Database" value={database?.status ?? 'not deployed'} />
            <Row label="Server CPU" value={cores(immich?.cpuUsage, 2)} />
            <Row label="Analysis CPU" value={cores(immichMl?.cpuUsage, 2)} />
            <hr className="divider" style={{ margin: '4px 0' }} />
            <InfoNote>
              The analysis worker is what makes faces and search work, and it is the expensive
              half. Gaming, Media and Desktop modes stop it outright — phones keep uploading,
              and the backlog is processed once the machine is free again.
            </InfoNote>
          </div>
        </Panel>

        <Panel title="Syncthing — file sync">
          <div className="stack" style={{ gap: 12 }}>
            <Row label="Status" value={syncthing?.status ?? 'not deployed'} />
            <Row label="CPU" value={cores(syncthing?.cpuUsage, 2)} />
            <Row label="Memory" value={bytes(syncthing?.memUsedBytes)} />
            <hr className="divider" style={{ margin: '4px 0' }} />
            <div className="stack" style={{ gap: 10 }}>
              <TierRow
                name="Sync folders"
                detail="Mirrored to your laptops peer-to-peer. No account, no server-side copy of your credentials."
                path={`${hdd?.mountpoint ?? '/mnt/hdd'}/Sync`}
              />
              <TierRow
                name="Projects"
                detail="Shared separately so a laptop can take just this folder."
                path={`${hdd?.mountpoint ?? '/mnt/hdd'}/Projects`}
              />
            </div>
            <InfoNote>
              The web interface is on the VPN only. Sync traffic itself is peer-to-peer on port
              22000 and never passes through the proxy.
            </InfoNote>
          </div>
        </Panel>
      </div>

      <Panel title="What replaced what" style={{ marginTop: 16 }}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Need</th>
                <th>Handled by</th>
                <th>Reachable from</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Phone photo backup</td>
                <td>Immich</td>
                <td>Anywhere, over HTTPS</td>
              </tr>
              <tr>
                <td>Folder sync between laptops</td>
                <td>Syncthing</td>
                <td>Peer-to-peer, no proxy</td>
              </tr>
              <tr>
                <td>Browsing and moving files</td>
                <td>This dashboard's Storage page</td>
                <td>VPN only</td>
              </tr>
              <tr>
                <td>Bulk and archive storage</td>
                <td>StorageBox, via the tiering rules</td>
                <td>VPN only</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>
          Calendar and contact sync were the one thing Nextcloud did that nothing here
          replaces. Radicale is about 30 MB if you want it back.
        </p>
      </Panel>
    </div>
  );
}

function TierRow({ name, detail, path }: { name: string; detail: string; path: string }) {
  return (
    <div>
      <div style={{ fontSize: 13.5, fontWeight: 560 }}>{name}</div>
      <div className="small muted" style={{ marginTop: 2, lineHeight: 1.5 }}>{detail}</div>
      <div className="mono small" style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{path}</div>
    </div>
  );
}

/* ------------------------------------------------------------ desktops -- */

export function DesktopsPage() {
  const { containers } = useLive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const desktop = containers.find((c) => c.serviceKey === 'desktop');
  const running = desktop?.state === 'running';

  const act = async (action: 'start' | 'stop'): Promise<void> => {
    if (!desktop) return;
    setBusy(true);
    setError('');
    try {
      await api.containerAction(desktop.id, action);
      if (action === 'start') await api.applyProfile('desktop');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Desktops</h1>
          <p className="page-subtitle">
            A full Linux desktop delivered to a browser tab. Strictly on demand — it wants two
            cores, so it only runs when you are actually using it.
          </p>
        </div>
        <span className={`badge ${running ? 'badge-good' : ''}`}>
          <span className={`dot ${running ? 'dot-good' : ''}`} />
          {running ? 'Running' : 'Offline'}
        </span>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="grid grid-2">
        <Panel title="Ubuntu XFCE">
          <div className="stack" style={{ gap: 14 }}>
            <div className="stack" style={{ gap: 7 }}>
              <Row label="CPU allocation" value="2 cores in Desktop mode" />
              <Row label="Memory allocation" value="4 GiB" />
              <Row label="Persistent storage" value="on the local HDD" />
              <Row label="Live CPU" value={running ? cores(desktop?.cpuUsage, 2) : '—'} />
              <Row label="Live memory" value={running ? bytes(desktop?.memUsedBytes) : '—'} />
            </div>

            {!desktop ? (
              <InfoNote>
                No container labelled <code className="mono">cloud.service=desktop</code> was
                found. Deploy it with{' '}
                <code className="mono">docker compose -f stack/docker-compose.desktop.yml up -d</code>.
              </InfoNote>
            ) : (
              <div className="btn-row">
                {running ? (
                  <>
                    <a
                      className="btn btn-primary"
                      href={`http://${window.location.hostname}:3000`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open desktop
                    </a>
                    <button className="btn btn-danger" onClick={() => void act('stop')} disabled={busy}>
                      {busy ? <span className="spinner" /> : 'Shut down'}
                    </button>
                  </>
                ) : (
                  <button className="btn btn-primary" onClick={() => void act('start')} disabled={busy}>
                    {busy ? <span className="spinner" /> : 'Launch desktop'}
                  </button>
                )}
              </div>
            )}
          </div>
        </Panel>

        <Panel title="What launching does">
          <div className="stack" style={{ gap: 12 }}>
            <Step n={1} text="Switches the machine into Desktop mode." />
            <Step n={2} text="Stops Minecraft if it is running, freeing its cores and memory." />
            <Step n={3} text="Drops Jellyfin to one core, enough for direct play." />
            <Step n={4} text="Starts the desktop container with two cores and 4 GiB." />
            <Step n={5} text="Pauses the storage tiering sweep so disk I/O stays responsive." />
            <hr className="divider" style={{ margin: '4px 0' }} />
            <InfoNote>
              Shutting the desktop down does not automatically restore Normal mode — pick it
              from the mode switcher when you are finished, or leave it if you are about to
              start something else.
            </InfoNote>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          borderRadius: 999,
          background: 'var(--accent-soft)',
          color: 'var(--accent)',
          display: 'grid',
          placeItems: 'center',
          fontSize: 11,
          fontWeight: 640,
          flex: 'none',
          marginTop: 1,
        }}
      >
        {n}
      </span>
      <span style={{ fontSize: 13 }}>{text}</span>
    </div>
  );
}

/* ------------------------------------------------------------- network -- */

export function NetworkPage() {
  const { host } = useLive();
  const rxSeries = useLiveSeries((h) => h.network.rxBytesPerSec);
  const txSeries = useLiveSeries((h) => h.network.txBytesPerSec);

  if (!host) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }

  const used = host.network.monthRxBytes + host.network.monthTxBytes;
  const allowance = host.network.monthAllowanceBytes;
  const ratio = allowance > 0 ? used / allowance : 0;

  // Days left in the current UTC month, for the projection below.
  const now = new Date();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  const projected = dayOfMonth > 0 ? (used / dayOfMonth) * daysInMonth : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Network</h1>
          <p className="page-subtitle">
            A 10 Gbit link with an 80 TB monthly allowance. At full tilt that allowance lasts
            about eighteen hours, so the counter is worth watching.
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatTile label="Download now" value={bitsPerSecond(host.network.rxBytesPerSec)} caption={host.network.iface} />
        <StatTile label="Upload now" value={bitsPerSecond(host.network.txBytesPerSec)} caption={host.network.iface} />
        <StatTile
          label="Used this month"
          value={bytes(used, 1)}
          caption={`${percent(ratio, 1)} of ${bytes(allowance, 0)}`}
          tone={ratio > 0.9 ? 'critical' : ratio > 0.75 ? 'warning' : undefined}
        />
        <StatTile
          label="Projected month total"
          value={bytes(projected, 1)}
          caption={
            projected > allowance
              ? 'on track to exceed the allowance'
              : `${percent(allowance > 0 ? projected / allowance : 0, 1)} of allowance`
          }
          tone={projected > allowance ? 'critical' : undefined}
        />
      </div>

      <Panel title="Monthly allowance" style={{ marginBottom: 16 }}>
        <Meter
          label={`${bytes(used, 1)} of ${bytes(allowance, 0)} used`}
          value={used}
          total={allowance}
          right={<span className="small tabular muted">{percent(ratio, 2)}</span>}
          height={12}
        />
        <div className="grid grid-3" style={{ marginTop: 18, gap: 16 }}>
          <Row label="Downloaded" value={bytes(host.network.monthRxBytes, 1)} />
          <Row label="Uploaded" value={bytes(host.network.monthTxBytes, 1)} />
          <Row label="Day of month" value={`${dayOfMonth} of ${daysInMonth}`} />
        </div>
      </Panel>

      <Panel title="Throughput, last few minutes">
        <div className="stack" style={{ gap: 18 }}>
          <div>
            <div className="row-between" style={{ marginBottom: 6 }}>
              <span className="metric-label">Download</span>
              <span className="small tabular">{bitsPerSecond(host.network.rxBytesPerSec)}</span>
            </div>
            <Sparkline data={rxSeries} color="var(--series-1)" height={64} format={bitsPerSecond} label="Download" />
          </div>
          <div>
            <div className="row-between" style={{ marginBottom: 6 }}>
              <span className="metric-label">Upload</span>
              <span className="small tabular">{bitsPerSecond(host.network.txBytesPerSec)}</span>
            </div>
            <Sparkline data={txSeries} color="var(--series-2)" height={64} format={bitsPerSecond} label="Upload" />
          </div>
        </div>
      </Panel>
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
