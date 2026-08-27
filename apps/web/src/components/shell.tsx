import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { ProfileId, Profile } from '@cloud/shared';
import { useLive } from '../lib/live';
import { api } from '../lib/api';
import { bytes, bitsPerSecond, percent, cores, duration } from '../lib/format';

export const NAV = [
  { to: '/', label: 'Overview', icon: '◉', end: true },
  { to: '/compute', label: 'Compute', icon: '⚡' },
  { to: '/containers', label: 'Containers', icon: '⬢' },
  { to: '/minecraft', label: 'Minecraft', icon: '⛏' },
  { to: '/media', label: 'Media', icon: '▶' },
  { to: '/cloud', label: 'Cloud', icon: '☁' },
  { to: '/storage', label: 'Storage', icon: '▤' },
  { to: '/desktops', label: 'Desktops', icon: '▭' },
  { to: '/network', label: 'Network', icon: '⇅' },
  { to: '/monitoring', label: 'Monitoring', icon: '◔' },
  { to: '/jobs', label: 'Jobs', icon: '◷' },
  { to: '/logs', label: 'Logs', icon: '☰' },
  { to: '/security', label: 'Security', icon: '⛨' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
] as const;

/* ------------------------------------------------------------- sidebar -- */

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { host, profile } = useLive();

  return (
    <nav
      style={{
        borderRight: '1px solid var(--hairline)',
        background: 'var(--plane-2)',
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 0,
        height: '100vh',
        overflowY: 'auto',
      }}
      aria-label="Sections"
    >
      <div style={{ padding: '18px 18px 14px' }}>
        <div className="row" style={{ gap: 10 }}>
          <div
            aria-hidden
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: 'linear-gradient(140deg, var(--accent), color-mix(in srgb, var(--accent) 45%, var(--series-1)))',
              display: 'grid',
              placeItems: 'center',
              fontSize: 15,
              color: 'var(--accent-ink)',
              fontWeight: 700,
              transition: 'background var(--normal) var(--ease)',
              flex: 'none',
            }}
          >
            ◆
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 640, letterSpacing: '-0.015em' }}>
              Control Centre
            </div>
            <div
              className="metric-label"
              style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {host?.hostname ?? 'connecting…'}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '0 10px', flex: 1 }}>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={'end' in item ? item.end : false}
            onClick={onNavigate}
            className={({ isActive }) => (isActive ? 'nav-item nav-item-active' : 'nav-item')}
          >
            <span aria-hidden style={{ width: 17, textAlign: 'center', opacity: 0.85 }}>
              {item.icon}
            </span>
            {item.label}
          </NavLink>
        ))}
      </div>

      <div style={{ padding: 14, borderTop: '1px solid var(--hairline)' }}>
        <div className="metric-label" style={{ marginBottom: 4 }}>
          Uptime
        </div>
        <div className="small tabular" style={{ fontWeight: 560 }}>
          {host ? duration(host.uptimeSec) : '—'}
        </div>
        {profile && (
          <div className="metric-label" style={{ marginTop: 8, fontSize: 11 }}>
            {profile.appliedBy === 'auto' ? 'Profile switched automatically' : 'Profile set manually'}
          </div>
        )}
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------- topbar -- */

export function TopBar({
  onOpenNav, theme, onToggleTheme,
}: {
  onOpenNav: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}) {
  const { host, connected } = useLive();
  const navigate = useNavigate();

  const nvme = host?.disks.find((d) => d.tier === 'nvme');
  const hdd = host?.disks.find((d) => d.tier === 'hdd');
  const remote = host?.disks.find((d) => d.tier === 'remote');

  const ratio = (used?: number, total?: number): string =>
    total && total > 0 ? percent((used ?? 0) / total) : '—';

  return (
    <header
      style={{
        height: 'var(--topbar-h)',
        borderBottom: '1px solid var(--hairline)',
        background: 'color-mix(in srgb, var(--plane-2) 82%, transparent)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '0 20px',
        position: 'sticky',
        top: 0,
        zIndex: 40,
      }}
    >
      <button
        className="btn btn-ghost btn-sm nav-toggle"
        onClick={onOpenNav}
        aria-label="Open navigation"
      >
        ☰
      </button>

      <ProfileSwitcher />

      <div className="topbar-stats">
        <TopStat label="CPU" value={host ? `${cores(host.cpu.usage * host.cpu.cores, 1)} / ${host.cpu.cores}` : '—'} />
        <TopStat
          label="RAM"
          value={host ? `${bytes(host.memory.usedBytes, 1)} / ${bytes(host.memory.totalBytes, 0)}` : '—'}
        />
        <TopStat label="NVMe" value={ratio(nvme?.usedBytes, nvme?.totalBytes)} />
        <TopStat label="HDD" value={ratio(hdd?.usedBytes, hdd?.totalBytes)} />
        <TopStat
          label="Remote"
          value={remote?.online ? ratio(remote.usedBytes, remote.totalBytes) : 'offline'}
          tone={remote && !remote.online ? 'critical' : undefined}
        />
        <TopStat
          label="Network"
          value={host ? `↓ ${bitsPerSecond(host.network.rxBytesPerSec)}  ↑ ${bitsPerSecond(host.network.txBytesPerSec)}` : '—'}
        />
      </div>

      <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
        <span
          className={`badge ${connected ? 'badge-good' : 'badge-warning'}`}
          title={connected ? 'Live updates are streaming' : 'Reconnecting to the server'}
        >
          <span className={`dot ${connected ? 'dot-good dot-pulse' : 'dot-warning'}`} />
          <span className="live-label">{connected ? 'Live' : 'Reconnecting'}</span>
        </span>

        <button
          className="btn btn-ghost btn-sm"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>

        <button
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            await api.logout().catch(() => undefined);
            navigate('/login', { replace: true });
            window.location.reload();
          }}
        >
          <span className="signout-label">Sign out</span>
          <span aria-hidden style={{ display: 'none' }} className="signout-icon">⏻</span>
        </button>
      </div>
    </header>
  );
}

function TopStat({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: 'critical';
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <span className="metric-label" style={{ fontSize: 10, letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span
        className="tabular nowrap"
        style={{
          fontSize: 12.5,
          fontWeight: 560,
          color: tone === 'critical' ? 'var(--critical)' : 'var(--text-primary)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

/* ----------------------------------------------------- profile switcher -- */

const PROFILE_ACCENT: Record<ProfileId, string> = {
  normal: '#38bdf8',
  gaming: '#a78bfa',
  media: '#fbbf24',
  desktop: '#34d399',
  custom: '#f472b6',
};

/**
 * Applying a profile re-tints the whole interface, so the current mode is felt
 * at a glance rather than needing to be read.
 */
export function applyAccent(id: ProfileId | undefined): void {
  const accent = PROFILE_ACCENT[id ?? 'normal'] ?? PROFILE_ACCENT.normal;
  const root = document.documentElement;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 15%, transparent)`);
  root.style.setProperty('--accent-line', `color-mix(in srgb, ${accent} 36%, transparent)`);
  // Dark ink on the light accents keeps button labels readable.
  root.style.setProperty('--accent-ink', '#06121a');
}

export function ProfileSwitcher() {
  const { profile } = useLive();
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [busy, setBusy] = useState<ProfileId | null>(null);

  useEffect(() => {
    if (!open || profiles.length > 0) return;
    api.profiles().then((r) => setProfiles(r.profiles)).catch(() => undefined);
  }, [open, profiles.length]);

  useEffect(() => {
    applyAccent(profile?.active);
  }, [profile?.active]);

  const active = useMemo(
    () => profiles.find((p) => p.id === profile?.active),
    [profiles, profile?.active],
  );

  const name = active?.name ?? (profile?.active ?? 'normal');

  const apply = async (id: ProfileId): Promise<void> => {
    setBusy(id);
    try {
      await api.applyProfile(id);
      applyAccent(id);
      setOpen(false);
    } catch {
      // The toast stream reports the failure.
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="btn btn-sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          borderColor: 'var(--accent-line)',
          background: 'var(--accent-soft)',
          color: 'var(--text-primary)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          fontSize: 11.5,
        }}
      >
        <span
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }}
        />
        {name} mode
        {profile?.pending && <span className="spinner" style={{ width: 11, height: 11 }} />}
        <span aria-hidden style={{ opacity: 0.6 }}>▾</span>
      </button>

      {open && (
        <>
          <div
            role="presentation"
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
          />
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              left: 0,
              width: 330,
              background: 'var(--surface-raised)',
              backdropFilter: 'blur(14px)',
              border: '1px solid var(--hairline-strong)',
              borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow-pop)',
              padding: 6,
              zIndex: 50,
              animation: 'rise 140ms var(--ease)',
            }}
          >
            {profiles.length === 0 && <div className="empty">Loading profiles…</div>}
            {profiles.map((p) => {
              const isActive = p.id === profile?.active;
              return (
                <button
                  key={p.id}
                  role="menuitem"
                  onClick={() => void apply(p.id)}
                  disabled={busy !== null}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: isActive ? 'var(--surface-3)' : 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    padding: '10px 12px',
                    cursor: busy ? 'wait' : 'pointer',
                    color: 'inherit',
                  }}
                >
                  <span className="row-between">
                    <span className="row" style={{ gap: 8 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: PROFILE_ACCENT[p.id],
                          flex: 'none',
                        }}
                      />
                      <strong style={{ fontSize: 13 }}>{p.name}</strong>
                    </span>
                    {isActive && <span className="badge badge-accent">Active</span>}
                    {busy === p.id && <span className="spinner" />}
                  </span>
                  <span
                    className="small muted"
                    style={{ display: 'block', marginTop: 3, lineHeight: 1.45 }}
                  >
                    {p.description}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
