import { useEffect, useState } from 'react';
import type { DirListing, FileEntry, StorageTierSummary } from '@cloud/shared';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import {
  Panel, Modal, Loading, ErrorNote, InfoNote, useConfirm, useStepUp, Toggle,
} from '../components/ui';
import { Meter, StackedBar } from '../components/charts';
import { bytes, percent, relativeTime, dateTime, count } from '../lib/format';

const MOUNT_FOR_TIER: Record<string, string> = {
  nvme: 'nvme',
  hdd: 'hdd',
  remote: 'storagebox',
};

export function StoragePage() {
  const { host, transfers } = useLive();
  const [mount, setMount] = useState('hdd');
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [moveTarget, setMoveTarget] = useState<FileEntry | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const { dialog: confirmDialog, confirm } = useConfirm();
  const { dialog: stepUpDialog, guard } = useStepUp();

  const tiers: StorageTierSummary[] =
    host?.disks.map((d) => ({
      tier: d.tier,
      label: d.label,
      mountpoint: d.mountpoint,
      totalBytes: d.totalBytes,
      usedBytes: d.usedBytes,
      freeBytes: d.freeBytes,
      online: d.online,
    })) ?? [];

  const load = async (nextMount = mount, nextPath = path): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setListing(await api.listDir(nextMount, nextPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that folder.');
      setListing(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(mount, path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mount, path]);

  const navigate = (entry: FileEntry): void => {
    if (entry.isDir) setPath(entry.path);
    else setSelected(entry);
  };

  const breadcrumbs = path.split('/').filter(Boolean);

  const remove = async (entry: FileEntry): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${entry.name}?`,
      body: entry.isDir
        ? 'This deletes the folder and everything inside it. There is no undo.'
        : 'This deletes the file permanently. There is no undo.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await guard('Deleting files is permanent.', () => api.remove(mount, entry.path));
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that.');
    }
  };

  const activeTransfers = transfers.filter(
    (t) => t.state === 'running' || t.state === 'queued',
  );

  return (
    <div className="page">
      {confirmDialog}
      {stepUpDialog}

      <div className="page-head">
        <div>
          <h1 className="page-title">Storage</h1>
          <p className="page-subtitle">
            Three tiers, one filesystem view. Fast NVMe for state, a local terabyte for the
            working set, and the StorageBox for bulk and archive.
          </p>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        {tiers.map((tier) => (
          <Panel
            key={tier.tier}
            title={tier.label}
            action={
              tier.online ? (
                <span className="small muted tabular">{bytes(tier.freeBytes, 0)} free</span>
              ) : (
                <span className="badge badge-critical">
                  <span className="dot dot-critical" />
                  Offline
                </span>
              )
            }
          >
            <Meter
              label={tier.mountpoint}
              value={tier.usedBytes}
              total={tier.totalBytes}
            />
            <div className="small muted" style={{ marginTop: 10 }}>
              {tier.tier === 'nvme' && 'OS, databases, container state, transcode cache.'}
              {tier.tier === 'hdd' && 'Active media, downloads, projects, local snapshots.'}
              {tier.tier === 'remote' && 'Cloud files, archive, encrypted vault, backups.'}
            </div>
          </Panel>
        ))}
      </div>

      <TieringPanel />

      {activeTransfers.length > 0 && (
        <Panel title="Transfers in progress" className="span-2" bodyClass="tight">
          <div className="stack" style={{ gap: 14 }}>
            {activeTransfers.map((transfer) => (
              <div key={transfer.id}>
                <div className="row-between" style={{ marginBottom: 5 }}>
                  <span className="small mono" style={{ wordBreak: 'break-all' }}>
                    {transfer.kind === 'move' ? 'Moving' : 'Copying'} {transfer.source} →{' '}
                    {transfer.destination}
                  </span>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => void api.cancelTransfer(transfer.id).catch(() => undefined)}
                  >
                    Cancel
                  </button>
                </div>
                <Meter
                  label=""
                  value={transfer.bytesDone}
                  total={transfer.bytesTotal || 1}
                  color="var(--accent)"
                  right={
                    <span className="small tabular muted">
                      {bytes(transfer.bytesDone)} / {bytes(transfer.bytesTotal)} ·{' '}
                      {bytes(transfer.speed)}/s
                      {transfer.etaSec !== null ? ` · ${transfer.etaSec}s left` : ''}
                    </span>
                  }
                />
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel
        style={{ marginTop: 16 }}
        title="Files"
        action={
          <div className="btn-row">
            <select
              className="input"
              style={{ width: 'auto', padding: '5px 30px 5px 10px', fontSize: 12 }}
              value={mount}
              onChange={(e) => {
                setMount(e.target.value);
                setPath('');
              }}
              aria-label="Storage tier"
            >
              {tiers.map((tier) => (
                <option key={tier.tier} value={MOUNT_FOR_TIER[tier.tier] ?? tier.tier}>
                  {tier.label}
                </option>
              ))}
            </select>
            <button className="btn btn-sm" onClick={() => setNewFolder(true)}>
              New folder
            </button>
            <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
              {loading ? <span className="spinner" /> : 'Refresh'}
            </button>
          </div>
        }
        bodyClass="flush"
      >
        <div
          className="row"
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--hairline)',
            gap: 6,
            flexWrap: 'wrap',
            fontSize: 13,
          }}
        >
          <button className="btn btn-ghost btn-sm" onClick={() => setPath('')}>
            {tiers.find((t) => MOUNT_FOR_TIER[t.tier] === mount)?.label ?? mount}
          </button>
          {breadcrumbs.map((segment, index) => (
            <span key={index} className="row" style={{ gap: 6 }}>
              <span className="muted">/</span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setPath(breadcrumbs.slice(0, index + 1).join('/'))}
              >
                {segment}
              </button>
            </span>
          ))}
        </div>

        {loading ? (
          <Loading />
        ) : !listing ? (
          <div className="empty">Nothing to show.</div>
        ) : listing.entries.length === 0 ? (
          <div className="empty">This folder is empty.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Size</th>
                  <th>Modified</th>
                  <th className="mono">Mode</th>
                  <th style={{ width: 1 }} />
                </tr>
              </thead>
              <tbody>
                {listing.parent !== null && (
                  <tr>
                    <td colSpan={5}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setPath(listing.parent ?? '')}
                      >
                        ↑ Up one level
                      </button>
                    </td>
                  </tr>
                )}
                {listing.entries.map((entry) => (
                  <tr key={entry.path}>
                    <td>
                      <button
                        className="btn btn-ghost btn-sm row"
                        style={{ padding: 0, gap: 8, fontWeight: entry.isDir ? 560 : 400 }}
                        onClick={() => navigate(entry)}
                      >
                        <span aria-hidden style={{ opacity: 0.7 }}>
                          {entry.isDir ? '▸' : '·'}
                        </span>
                        {entry.name}
                      </button>
                    </td>
                    <td className="num tabular muted">
                      {entry.isDir ? '—' : bytes(entry.sizeBytes)}
                    </td>
                    <td className="small muted">{relativeTime(entry.modifiedAt)}</td>
                    <td className="mono muted small">{entry.mode}</td>
                    <td>
                      <div className="btn-row nowrap">
                        <button className="btn btn-sm" onClick={() => setMoveTarget(entry)}>
                          Move
                        </button>
                        {!entry.isDir && (
                          <a
                            className="btn btn-sm"
                            href={api.downloadUrl(mount, entry.path)}
                            download
                          >
                            Download
                          </a>
                        )}
                        <button className="btn btn-sm btn-danger" onClick={() => void remove(entry)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {listing.truncated && (
              <div className="empty">
                This folder has more entries than can be listed at once.
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* ------------------------------------------------------- dialogs -- */}

      <Modal open={newFolder} title="New folder" onClose={() => setNewFolder(false)}>
        <div className="field">
          <label className="field-label" htmlFor="folder">Name</label>
          <input
            id="folder"
            className="input"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={() => setNewFolder(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!folderName.trim()}
            onClick={() =>
              void (async () => {
                try {
                  await api.createFolder(mount, path, folderName.trim());
                  setNewFolder(false);
                  setFolderName('');
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not create that folder.');
                }
              })()
            }
          >
            Create
          </button>
        </div>
      </Modal>

      <MoveDialog
        entry={moveTarget}
        sourceMount={mount}
        tiers={tiers}
        onClose={() => setMoveTarget(null)}
        onDone={() => {
          setMoveTarget(null);
          void load();
        }}
      />

      <Modal open={selected !== null} title={selected?.name ?? ''} onClose={() => setSelected(null)}>
        {selected && (
          <div className="stack" style={{ gap: 8 }}>
            <Row label="Path" value={`/${selected.path}`} />
            <Row label="Size" value={bytes(selected.sizeBytes)} />
            <Row label="Modified" value={dateTime(selected.modifiedAt)} />
            <Row label="Permissions" value={selected.mode} />
            <div className="btn-row" style={{ marginTop: 10 }}>
              <a className="btn" href={api.downloadUrl(mount, selected.path)} download>
                Download
              </a>
              <button className="btn" onClick={() => { setMoveTarget(selected); setSelected(null); }}>
                Move to another tier
              </button>
              <button className="btn btn-danger" onClick={() => void remove(selected)}>
                Delete
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------- move dialog -- */

function MoveDialog({
  entry, sourceMount, tiers, onClose, onDone,
}: {
  entry: FileEntry | null;
  sourceMount: string;
  tiers: StorageTierSummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [destMount, setDestMount] = useState('storagebox');
  const [destPath, setDestPath] = useState('');
  const [kind, setKind] = useState<'move' | 'copy'>('move');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (entry) {
      // Mirroring the source path keeps the layout predictable across tiers.
      setDestPath(entry.path);
      setError('');
    }
  }, [entry]);

  const submit = async (): Promise<void> => {
    if (!entry) return;
    setBusy(true);
    setError('');
    try {
      await api.startTransfer({
        kind,
        sourceMount,
        sourcePath: entry.path,
        destMount,
        destPath: destPath.trim(),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start that transfer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={entry !== null} title={`Move ${entry?.name ?? ''}`} onClose={onClose} width={520}>
      <ErrorNote>{error}</ErrorNote>
      <div className="field">
        <span className="field-label">Operation</span>
        <div className="btn-row">
          <button
            className={`btn btn-sm ${kind === 'move' ? 'btn-primary' : ''}`}
            onClick={() => setKind('move')}
          >
            Move
          </button>
          <button
            className={`btn btn-sm ${kind === 'copy' ? 'btn-primary' : ''}`}
            onClick={() => setKind('copy')}
          >
            Copy
          </button>
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="dest-tier">Destination tier</label>
        <select
          id="dest-tier"
          className="input"
          value={destMount}
          onChange={(e) => setDestMount(e.target.value)}
        >
          {tiers.map((tier) => (
            <option key={tier.tier} value={MOUNT_FOR_TIER[tier.tier] ?? tier.tier}>
              {tier.label} — {bytes(tier.freeBytes, 0)} free
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="dest-path">Destination path</label>
        <input
          id="dest-path"
          className="input mono"
          value={destPath}
          onChange={(e) => setDestPath(e.target.value)}
        />
        <span className="field-hint">Relative to the destination tier's root.</span>
      </div>

      <InfoNote>
        Transfers run through rclone, so they resume and verify checksums. Large moves to the
        StorageBox are limited to two at a time.
      </InfoNote>

      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !destPath.trim()}>
          {busy ? <span className="spinner" /> : `Start ${kind}`}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------- tiering panel -- */

function TieringPanel() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.tiering>> | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = (): void => {
    api
      .tiering()
      .then(setData)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not load tiering rules.'),
      );
  };

  useEffect(load, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return null;

  const rules = data.rules as {
    enabled: boolean;
    coldAfterDays: number;
    targetUsedRatio: number;
    minSizeBytes: number;
  };

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setSaving(true);
    try {
      await api.saveTiering({ ...rules, ...patch });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="Automatic tiering"
      style={{ marginBottom: 16 }}
      action={
        <Toggle
          checked={rules.enabled}
          disabled={saving}
          label={rules.enabled ? 'On' : 'Off'}
          onChange={(next) => void save({ enabled: next })}
        />
      }
    >
      <div className="grid grid-2" style={{ gap: 22 }}>
        <div>
          <div className="metric-label" style={{ marginBottom: 10 }}>
            Where your data lives
          </div>
          <StackedBar
            segments={[
              { label: 'Hot (NVMe)', value: data.summary.hotBytes, color: 'var(--tier-hot)' },
              { label: 'Warm (HDD)', value: data.summary.warmBytes, color: 'var(--tier-warm)' },
              { label: 'Cold (StorageBox)', value: data.summary.coldBytes, color: 'var(--tier-cold)' },
            ]}
          />
        </div>

        <div>
          <div className="metric-label" style={{ marginBottom: 10 }}>
            Next candidates to move down
          </div>
          {data.summary.candidates.length === 0 ? (
            <div className="small muted">
              Nothing qualifies right now. Files become candidates after{' '}
              {rules.coldAfterDays} days untouched.
            </div>
          ) : (
            <div className="scroll-y" style={{ maxHeight: 150 }}>
              {data.summary.candidates.slice(0, 8).map((candidate) => (
                <div
                  key={candidate.path}
                  className="row-between small"
                  style={{ padding: '4px 0', gap: 12 }}
                >
                  <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {candidate.path}
                  </span>
                  <span className="tabular muted nowrap">
                    {bytes(candidate.sizeBytes, 0)} · {candidate.lastAccessDays}d
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <hr className="divider" />

      <div className="grid grid-3" style={{ gap: 18 }}>
        <div>
          <div className="row-between" style={{ marginBottom: 2 }}>
            <span className="field-label">Cold after</span>
            <span className="small tabular">{rules.coldAfterDays} days</span>
          </div>
          <input
            className="slider"
            type="range"
            min={7}
            max={365}
            step={1}
            value={rules.coldAfterDays}
            style={{ ['--fill' as string]: `${((rules.coldAfterDays - 7) / 358) * 100}%` }}
            onChange={(e) => void save({ coldAfterDays: Number(e.target.value) })}
          />
        </div>
        <div>
          <div className="row-between" style={{ marginBottom: 2 }}>
            <span className="field-label">Keep HDD below</span>
            <span className="small tabular">{percent(rules.targetUsedRatio)}</span>
          </div>
          <input
            className="slider"
            type="range"
            min={0.3}
            max={0.95}
            step={0.05}
            value={rules.targetUsedRatio}
            style={{ ['--fill' as string]: `${((rules.targetUsedRatio - 0.3) / 0.65) * 100}%` }}
            onChange={(e) => void save({ targetUsedRatio: Number(e.target.value) })}
          />
        </div>
        <div>
          <div className="row-between" style={{ marginBottom: 2 }}>
            <span className="field-label">Only files over</span>
            <span className="small tabular">{bytes(rules.minSizeBytes, 0)}</span>
          </div>
          <input
            className="slider"
            type="range"
            min={16}
            max={4096}
            step={16}
            value={rules.minSizeBytes / (1024 * 1024)}
            style={{ ['--fill' as string]: `${((rules.minSizeBytes / (1024 * 1024) - 16) / 4080) * 100}%` }}
            onChange={(e) => void save({ minSizeBytes: Number(e.target.value) * 1024 * 1024 })}
          />
        </div>
      </div>

      <p className="small muted" style={{ marginTop: 14 }}>
        The sweep runs nightly and only when the HDD is above its target. It moves the coldest,
        largest files first and never exceeds its per-run byte cap, so it cannot saturate the
        link. Jellyfin keeps playing files that have moved — they stream from the StorageBox.
      </p>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between small" style={{ gap: 16 }}>
      <span className="muted nowrap">{label}</span>
      <span className="mono" style={{ textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}
