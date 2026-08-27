import { useEffect, useState } from 'react';
import type { Profile, ProfileId, ProfileAllocation } from '@cloud/shared';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { Panel, Loading, ErrorNote, InfoNote, useStepUp } from '../components/ui';
import { CoreBars, Meter } from '../components/charts';
import { bytes, cores, percent } from '../lib/format';
import { applyAccent } from '../components/shell';

const GiB = 1024 ** 3;

const PROFILE_TINT: Record<ProfileId, string> = {
  normal: '#38bdf8',
  gaming: '#a78bfa',
  media: '#fbbf24',
  desktop: '#34d399',
  quiet: '#94a3b8',
  custom: '#f472b6',
};

export function ComputePage() {
  const { host, containers, profile } = useLive();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [custom, setCustom] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<ProfileId | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const { dialog, guard } = useStepUp();

  useEffect(() => {
    api
      .profiles()
      .then((r) => {
        setProfiles(r.profiles);
        setCustom(r.profiles.find((p) => p.id === 'custom') ?? null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not load profiles.'),
      );
  }, []);

  const apply = async (id: ProfileId): Promise<void> => {
    setBusy(id);
    setError('');
    try {
      const result = await api.applyProfile(id);
      applyAccent(id);
      const failures = result.changes.filter((c) => !c.ok);
      if (failures.length > 0) {
        setError(
          `Applied with problems: ${failures.map((f) => `${f.serviceKey} (${f.error})`).join(', ')}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply that profile.');
    } finally {
      setBusy(null);
    }
  };

  const saveCustom = async (): Promise<void> => {
    if (!custom) return;
    setSaving(true);
    setError('');
    try {
      await guard('Changing resource allocation affects every running service.', () =>
        api.saveCustomProfile(custom),
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the custom profile.');
    } finally {
      setSaving(false);
    }
  };

  const updateAllocation = (index: number, patch: Partial<ProfileAllocation>): void => {
    if (!custom) return;
    const next = [...custom.allocations];
    const current = next[index];
    if (!current) return;
    next[index] = { ...current, ...patch };
    setCustom({ ...custom, allocations: next });
  };

  const updateLimit = (index: number, patch: { cpus?: number | null; memoryBytes?: number | null }): void => {
    if (!custom) return;
    const next = [...custom.allocations];
    const current = next[index];
    if (!current) return;
    next[index] = { ...current, limits: { ...current.limits, ...patch } };
    setCustom({ ...custom, allocations: next });
  };

  if (!host) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }

  const totalCpuAllocated =
    custom?.allocations
      .filter((a) => a.action !== 'stop')
      .reduce((sum, a) => sum + (a.limits.cpus ?? 0), 0) ?? 0;
  const totalMemAllocated =
    custom?.allocations
      .filter((a) => a.action !== 'stop')
      .reduce((sum, a) => sum + (a.limits.memoryBytes ?? 0), 0) ?? 0;

  return (
    <div className="page">
      {dialog}
      <div className="page-head">
        <div>
          <h1 className="page-title">Compute</h1>
          <p className="page-subtitle">
            Four vCPUs and {bytes(host.memory.totalBytes, 0)} of RAM, divided by what you are
            actually doing. Switching a profile rewrites live container limits — no restart,
            no redeploy.
          </p>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Panel title="Live utilisation">
          <div className="stack" style={{ gap: 18 }}>
            <div>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <span className="metric-label">Per-core</span>
                <span className="small tabular">
                  {cores(host.cpu.usage * host.cpu.cores, 2)} / {host.cpu.cores} cores
                </span>
              </div>
              <CoreBars perCore={host.cpu.perCore} />
            </div>
            <Meter
              label="Memory"
              value={host.memory.usedBytes}
              total={host.memory.totalBytes}
            />
            {host.memory.swapTotalBytes > 0 && (
              <Meter
                label="Swap"
                value={host.memory.swapUsedBytes}
                total={host.memory.swapTotalBytes}
              />
            )}
          </div>
        </Panel>

        <Panel title="What each service is using">
          {containers.filter((c) => c.state === 'running').length === 0 ? (
            <div className="empty">Nothing is running.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Container</th>
                    <th className="num">CPU</th>
                    <th className="num">Memory</th>
                    <th className="num">Ceiling</th>
                  </tr>
                </thead>
                <tbody>
                  {containers
                    .filter((c) => c.state === 'running')
                    .sort((a, b) => (b.cpuUsage ?? 0) - (a.cpuUsage ?? 0))
                    .map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="num tabular">{cores(c.cpuUsage, 2)}</td>
                        <td className="num tabular">{bytes(c.memUsedBytes)}</td>
                        <td className="num tabular muted">
                          {c.memLimitBytes && c.memLimitBytes < host.memory.totalBytes
                            ? bytes(c.memLimitBytes, 0)
                            : 'unlimited'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <h2 style={{ fontSize: 15, fontWeight: 620, margin: '24px 0 12px' }}>Resource profiles</h2>

      <div className="grid grid-auto" style={{ marginBottom: 24 }}>
        {profiles
          .filter((p) => p.id !== 'custom')
          .map((p) => {
            const isActive = profile?.active === p.id;
            return (
              <div
                key={p.id}
                className="panel"
                style={{
                  borderColor: isActive ? PROFILE_TINT[p.id] : undefined,
                  boxShadow: isActive
                    ? `0 0 0 1px ${PROFILE_TINT[p.id]}, var(--shadow-panel)`
                    : undefined,
                }}
              >
                <div className="panel-body">
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: 999,
                          background: PROFILE_TINT[p.id],
                        }}
                      />
                      <strong style={{ fontSize: 15 }}>{p.name}</strong>
                    </span>
                    {isActive && <span className="badge badge-accent">Active</span>}
                  </div>

                  <p className="small secondary" style={{ minHeight: 54, lineHeight: 1.5 }}>
                    {p.description}
                  </p>

                  <div className="stack" style={{ gap: 5, margin: '12px 0 14px' }}>
                    {p.allocations.map((a) => (
                      <div
                        key={a.serviceKey}
                        className="row-between small"
                        style={{ opacity: a.action === 'stop' ? 0.45 : 1 }}
                      >
                        <span style={{ textTransform: 'capitalize' }}>{a.serviceKey}</span>
                        <span className="tabular muted">
                          {a.action === 'stop'
                            ? 'off'
                            : `${cores(a.limits.cpus, 2)} cpu · ${bytes(a.limits.memoryBytes, 0)}`}
                        </span>
                      </div>
                    ))}
                  </div>

                  {p.pauseJobs.length > 0 && (
                    <div className="small muted" style={{ marginBottom: 12 }}>
                      Pauses: {p.pauseJobs.join(', ')}
                    </div>
                  )}

                  <button
                    className={`btn btn-block ${isActive ? '' : 'btn-primary'}`}
                    disabled={isActive || busy !== null}
                    onClick={() => void apply(p.id)}
                  >
                    {busy === p.id ? <span className="spinner" /> : isActive ? 'Currently active' : `Switch to ${p.name}`}
                  </button>
                </div>
              </div>
            );
          })}
      </div>

      <Panel
        title="Custom allocation"
        action={
          <div className="btn-row">
            {saved && <span className="badge badge-good">Saved</span>}
            <button className="btn btn-sm" onClick={() => void saveCustom()} disabled={saving || !custom}>
              {saving ? <span className="spinner" /> : 'Save'}
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void apply('custom')}
              disabled={busy !== null || !custom}
            >
              {busy === 'custom' ? <span className="spinner" /> : 'Save & apply'}
            </button>
          </div>
        }
      >
        {!custom ? (
          <Loading />
        ) : (
          <>
            <div style={{ marginBottom: 18 }}>
              <InfoNote>
                CPU limits are hard ceilings, so the total may exceed {host.cpu.cores} cores —
                idle services never claim theirs. Currently allocating{' '}
                <strong className="tabular">{totalCpuAllocated.toFixed(2)}</strong> cores and{' '}
                <strong className="tabular">{bytes(totalMemAllocated, 1)}</strong> of{' '}
                {bytes(host.memory.totalBytes, 0)}.
                {totalMemAllocated > host.memory.totalBytes && (
                  <span style={{ color: 'var(--warning)' }}>
                    {' '}Memory ceilings exceed physical RAM — services may be killed under
                    pressure.
                  </span>
                )}
              </InfoNote>
            </div>

            <div className="stack" style={{ gap: 22 }}>
              {custom.allocations.map((allocation, index) => {
                const cpuValue = allocation.limits.cpus ?? 0;
                const memValue = (allocation.limits.memoryBytes ?? 0) / GiB;
                const maxMem = host.memory.totalBytes / GiB;
                const disabled = allocation.action === 'stop';

                return (
                  <div
                    key={allocation.serviceKey}
                    style={{
                      paddingBottom: 18,
                      borderBottom: '1px solid var(--grid)',
                      opacity: disabled ? 0.55 : 1,
                    }}
                  >
                    <div className="row-between" style={{ marginBottom: 12 }}>
                      <strong style={{ fontSize: 14, textTransform: 'capitalize' }}>
                        {allocation.serviceKey}
                      </strong>
                      <div className="btn-row">
                        {(['run', 'leave', 'stop'] as const).map((action) => (
                          <button
                            key={action}
                            className={`btn btn-sm ${allocation.action === action ? 'btn-primary' : ''}`}
                            onClick={() => updateAllocation(index, { action })}
                          >
                            {action === 'run' ? 'Run' : action === 'leave' ? 'Leave as-is' : 'Stop'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-2" style={{ gap: 20 }}>
                      <div>
                        <div className="row-between" style={{ marginBottom: 2 }}>
                          <span className="field-label">CPU ceiling</span>
                          <span className="small tabular">
                            {cpuValue > 0 ? `${cpuValue.toFixed(2)} / ${host.cpu.cores}` : 'unlimited'}
                          </span>
                        </div>
                        <input
                          className="slider"
                          type="range"
                          min={0}
                          max={host.cpu.cores}
                          step={0.25}
                          value={cpuValue}
                          disabled={disabled}
                          style={{ ['--fill' as string]: `${(cpuValue / host.cpu.cores) * 100}%` }}
                          onChange={(e) =>
                            updateLimit(index, {
                              cpus: Number(e.target.value) === 0 ? null : Number(e.target.value),
                            })
                          }
                        />
                      </div>

                      <div>
                        <div className="row-between" style={{ marginBottom: 2 }}>
                          <span className="field-label">Memory ceiling</span>
                          <span className="small tabular">
                            {memValue > 0 ? `${memValue.toFixed(1)} GiB` : 'unlimited'}
                          </span>
                        </div>
                        <input
                          className="slider"
                          type="range"
                          min={0}
                          max={maxMem}
                          step={0.5}
                          value={memValue}
                          disabled={disabled}
                          style={{ ['--fill' as string]: `${(memValue / maxMem) * 100}%` }}
                          onChange={(e) =>
                            updateLimit(index, {
                              memoryBytes:
                                Number(e.target.value) === 0 ? null : Number(e.target.value) * GiB,
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
