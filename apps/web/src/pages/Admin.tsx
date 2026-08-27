import { useEffect, useState, type FormEvent } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import type { AuditEntry, SessionInfo, User } from '@cloud/shared';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import {
  Panel, Modal, Loading, ErrorNote, InfoNote, useConfirm, useStepUp, useAsync,
} from '../components/ui';
import { dateTime, relativeTime, bytes, cores } from '../lib/format';

/* ---------------------------------------------------------------- logs -- */

export function LogsPage() {
  const { containers } = useLive();
  const [selected, setSelected] = useState('');
  const [logs, setLogs] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const running = containers.filter((c) => c.state === 'running');

  useEffect(() => {
    if (!selected && running.length > 0) setSelected(running[0]!.id);
  }, [running, selected]);

  const load = async (): Promise<void> => {
    if (!selected) return;
    setLoading(true);
    try {
      const result = await api.containerLogs(selected, 500);
      setLogs(result.logs);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read logs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, selected]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Logs</h1>
          <p className="page-subtitle">Container output, straight from the Docker daemon.</p>
        </div>
        <div className="btn-row">
          <select
            className="input"
            style={{ width: 'auto', minWidth: 190 }}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Container"
          >
            {containers.length === 0 && <option>No containers</option>}
            {containers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.state !== 'running' ? `(${c.state})` : ''}
              </option>
            ))}
          </select>
          <button
            className={`btn btn-sm ${autoRefresh ? 'btn-primary' : ''}`}
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? 'Live' : 'Paused'}
          </button>
          <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? <span className="spinner" /> : 'Refresh'}
          </button>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <Panel bodyClass="tight">
        {loading && !logs ? (
          <Loading />
        ) : (
          <div className="log-view" style={{ maxHeight: '68vh' }}>
            {logs || 'No output.'}
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------ security -- */

export function SecurityPage() {
  const [me, setMe] = useState<Awaited<ReturnType<typeof api.me>> | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [passkeys, setPasskeys] = useState<Awaited<ReturnType<typeof api.passkeys>>>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [addingUser, setAddingUser] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const { dialog: confirmDialog, confirm } = useConfirm();
  const { dialog: stepUpDialog, guard } = useStepUp();

  const reload = (): void => {
    api.me().then(setMe).catch(() => undefined);
    api.sessions().then(setSessions).catch(() => undefined);
    api.passkeys().then(setPasskeys).catch(() => undefined);
    api.users().then(setUsers).catch(() => undefined);
    api.audit(120).then(setAudit).catch(() => undefined);
  };

  useEffect(reload, []);

  const addPasskey = async (): Promise<void> => {
    setError('');
    try {
      const options = await api.passkeyBegin();
      const attestation = await startRegistration({ optionsJSON: options as never });
      const label = window.prompt('Name this security key', 'My device') ?? 'Security key';
      await api.passkeyFinish(attestation, label);
      setNotice('Passkey added.');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that passkey.');
    }
  };

  const removePasskey = async (id: string, label: string): Promise<void> => {
    const ok = await confirm({
      title: `Remove "${label}"?`,
      body: 'You will no longer be able to sign in with that device.',
      danger: true,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await guard('Removing a passkey changes how you sign in.', () => api.passkeyDelete(id));
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that passkey.');
    }
  };

  const regenerate = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Generate new recovery codes?',
      body: 'Your existing codes stop working immediately. Save the new ones.',
      confirmLabel: 'Generate',
    });
    if (!ok) return;
    try {
      const result = await guard('Recovery codes bypass two-factor authentication.', () =>
        api.regenerateRecoveryCodes(),
      );
      if (result) setNewCodes(result.codes);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not regenerate codes.');
    }
  };

  const removeUser = async (user: User): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${user.username}?`,
      body: 'Their sessions, passkeys and recovery codes are all deleted.',
      danger: true,
      confirmLabel: 'Delete account',
    });
    if (!ok) return;
    try {
      await guard('Deleting an account is permanent.', () => api.deleteUser(user.id));
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that account.');
    }
  };

  if (!me) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }

  return (
    <div className="page">
      {confirmDialog}
      {stepUpDialog}

      <div className="page-head">
        <div>
          <h1 className="page-title">Security</h1>
          <p className="page-subtitle">
            Accounts, second factors, active sessions and a full audit trail of everything the
            dashboard has done.
          </p>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>
      {notice && (
        <div style={{ marginBottom: 14 }}>
          <InfoNote>{notice}</InfoNote>
        </div>
      )}

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Panel title="Your account">
          <div className="stack" style={{ gap: 9 }}>
            <Row label="Username" value={me.user.username} />
            <Row label="Display name" value={me.user.displayName} />
            <Row label="Role" value={me.user.role} />
            <Row label="Two-factor" value={me.user.totpEnrolled ? 'enabled' : 'NOT ENABLED'} />
            <Row label="Recovery codes left" value={String(me.recoveryCodesRemaining)} />
            <Row label="Last sign-in" value={relativeTime(me.user.lastLoginAt)} />
          </div>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn btn-sm" onClick={() => setChangingPassword(true)}>
              Change password
            </button>
            <button className="btn btn-sm" onClick={() => void regenerate()}>
              New recovery codes
            </button>
          </div>
          {me.recoveryCodesRemaining <= 2 && (
            <div style={{ marginTop: 12 }}>
              <InfoNote>
                Only {me.recoveryCodesRemaining} recovery code
                {me.recoveryCodesRemaining === 1 ? '' : 's'} left. Generate a fresh set.
              </InfoNote>
            </div>
          )}
        </Panel>

        <Panel
          title="Passkeys"
          action={
            <button className="btn btn-sm" onClick={() => void addPasskey()}>
              Add passkey
            </button>
          }
        >
          {passkeys.length === 0 ? (
            <div className="empty">
              No passkeys registered. A passkey lets you sign in with a fingerprint, face or
              hardware key instead of typing a code.
            </div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {passkeys.map((key) => (
                <div key={key.id} className="row-between">
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 550 }}>{key.label}</div>
                    <div className="metric-label">
                      added {relativeTime(key.createdAt)} · last used {relativeTime(key.lastUsedAt)}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => void removePasskey(key.id, key.label)}
                    aria-label={`Remove ${key.label}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Panel title="Active sessions">
          <div className="stack" style={{ gap: 12 }}>
            {sessions.map((session) => (
              <div key={session.id} className="row-between">
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 7 }}>
                    <span style={{ fontSize: 13, fontWeight: 550 }}>
                      {session.ip || 'unknown address'}
                    </span>
                    {session.current && <span className="badge badge-accent">This device</span>}
                  </div>
                  <div
                    className="metric-label"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}
                  >
                    {session.userAgent || 'unknown client'}
                  </div>
                  <div className="metric-label">
                    started {relativeTime(session.createdAt)} · seen {relativeTime(session.lastSeenAt)}
                  </div>
                </div>
                {!session.current && (
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() =>
                      void api.revokeSession(session.id).then(reload).catch(() => undefined)
                    }
                  >
                    Sign out
                  </button>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Accounts"
          action={
            me.user.role === 'owner' && (
              <button className="btn btn-sm" onClick={() => setAddingUser(true)}>
                Add account
              </button>
            )
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            {users.map((user) => (
              <div key={user.id} className="row-between">
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 550 }}>
                    {user.displayName}{' '}
                    <span className="muted" style={{ fontWeight: 400 }}>@{user.username}</span>
                  </div>
                  <div className="metric-label">
                    {user.role} · {user.totpEnrolled ? '2FA on' : '2FA pending'} ·{' '}
                    {user.passkeyCount} passkey{user.passkeyCount === 1 ? '' : 's'}
                  </div>
                </div>
                {me.user.role === 'owner' && user.id !== me.user.id && (
                  <button className="btn btn-sm btn-ghost" onClick={() => void removeUser(user)}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Audit log" bodyClass="flush">
        <div className="table-wrap scroll-y" style={{ maxHeight: 420 }}>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td className="small muted nowrap">{dateTime(entry.at)}</td>
                  <td className="small">{entry.username ?? '—'}</td>
                  <td className="mono small">{entry.action}</td>
                  <td
                    className="small muted"
                    style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {entry.target ?? entry.detail ?? '—'}
                  </td>
                  <td>
                    <span
                      className={`badge ${entry.outcome === 'ok' ? 'badge-good' : entry.outcome === 'denied' ? 'badge-critical' : 'badge-warning'}`}
                    >
                      {entry.outcome}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <AddUserDialog open={addingUser} onClose={() => { setAddingUser(false); reload(); }} />
      <ChangePasswordDialog open={changingPassword} onClose={() => setChangingPassword(false)} />

      <Modal open={newCodes !== null} title="Your new recovery codes" onClose={() => setNewCodes(null)}>
        <p className="secondary small">
          Save these now — the previous set no longer works and these will not be shown again.
        </p>
        <div className="recovery-grid">
          {newCodes?.map((code) => (
            <span key={code}>{code}</span>
          ))}
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={() => setNewCodes(null)}>
            I have saved them
          </button>
        </div>
      </Modal>
    </div>
  );
}

function AddUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { dialog, guard } = useStepUp();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await guard('Creating an account grants access to this machine.', () =>
        api.createUser({ username: username.trim(), displayName: displayName.trim(), password, role }),
      );
      setUsername('');
      setDisplayName('');
      setPassword('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that account.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {dialog}
      <Modal open={open} title="Add an account" onClose={onClose}>
        <ErrorNote>{error}</ErrorNote>
        <form onSubmit={submit}>
          <div className="field">
            <label className="field-label" htmlFor="u-name">Username</label>
            <input id="u-name" className="input" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="u-display">Display name</label>
            <input id="u-display" className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="u-password">Temporary password</label>
            <input id="u-password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <span className="field-hint">
              At least 12 characters. They set up their own two-factor on first sign-in.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="u-role">Role</label>
            <select id="u-role" className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member — can view everything</option>
              <option value="admin">Admin — can control services and storage</option>
            </select>
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" /> : 'Create account'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (next !== confirmValue) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.changePassword(current, next);
      setDone(
        `Password changed. ${result.otherSessionsRevoked} other session${result.otherSessionsRevoked === 1 ? '' : 's'} signed out.`,
      );
      setCurrent('');
      setNext('');
      setConfirmValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Change password" onClose={() => { setDone(''); onClose(); }}>
      <ErrorNote>{error}</ErrorNote>
      {done ? (
        <>
          <InfoNote>{done}</InfoNote>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => { setDone(''); onClose(); }}>Done</button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <div className="field">
            <label className="field-label" htmlFor="p-current">Current password</label>
            <input id="p-current" className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="p-next">New password</label>
            <input id="p-next" className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="p-confirm">Confirm new password</label>
            <input id="p-confirm" className="input" type="password" value={confirmValue} onChange={(e) => setConfirmValue(e.target.value)} autoComplete="new-password" required />
          </div>
          <InfoNote>Every other signed-in device is signed out when the password changes.</InfoNote>
          <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" /> : 'Change password'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------ settings -- */

export function SettingsPage() {
  const { data, error, loading } = useAsync(() => api.settings(), []);
  const { host } = useLive();

  if (loading) return <div className="page"><Loading /></div>;
  if (error) return <div className="page"><ErrorNote>{error}</ErrorNote></div>;
  if (!data) return null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            How this instance is configured. Everything here comes from environment variables,
            so it is changed in <code className="mono">.env</code> and applied on restart.
          </p>
        </div>
      </div>

      <div className="grid grid-2">
        <Panel title="Integrations">
          <div className="stack" style={{ gap: 10 }}>
            <IntegrationRow name="Docker" ok={data.integrations.docker} detail="container control and live stats" />
            <IntegrationRow name="Jellyfin" ok={data.integrations.jellyfin} detail="stream and transcode visibility" />
            <IntegrationRow name="Minecraft RCON" ok={data.integrations.minecraft} detail="players, TPS and console" />
            <IntegrationRow
              name="rclone"
              ok={data.integrations.rclone !== null}
              detail={data.integrations.rclone ?? 'not installed — tiering and backups need it'}
            />
          </div>
        </Panel>

        <Panel title="Storage mounts">
          <div className="stack" style={{ gap: 10 }}>
            {data.mounts.map((mount) => {
              const disk = host?.disks.find((d) => d.id === mount.id);
              return (
                <div key={mount.id} className="row-between">
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 550 }}>{mount.label}</div>
                    <div className="metric-label mono">{mount.mountpoint}</div>
                  </div>
                  <span className={`badge ${disk?.online ? 'badge-good' : 'badge-critical'}`}>
                    <span className={`dot ${disk?.online ? 'dot-good' : 'dot-critical'}`} />
                    {disk?.online ? bytes(disk.totalBytes, 0) : 'offline'}
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Network">
          <div className="stack" style={{ gap: 9 }}>
            <Row label="Interface" value={data.network.iface} />
            <Row label="Monthly allowance" value={bytes(data.network.allowanceBytes, 0)} />
            <Row
              label="Link speed"
              value={data.network.linkSpeedMbps ? `${data.network.linkSpeedMbps / 1000} Gbps` : 'unknown'}
            />
            <Row label="Public origin" value={data.origin} />
          </div>
        </Panel>

        <Panel title="Security policy">
          <div className="stack" style={{ gap: 9 }}>
            <Row label="Session lifetime" value={`${data.security.sessionTtlDays} days`} />
            <Row
              label="Step-up required"
              value={data.security.requireStepUp ? 'yes, for destructive actions' : 'no'}
            />
            <Row
              label="Step-up window"
              value={`${Math.round(data.security.stepUpWindowSec / 60)} minutes`}
            />
          </div>
          <div style={{ marginTop: 14 }}>
            <InfoNote>
              The control plane binds to loopback by default and is published only over the VPN.
              Public services go through Caddy on their own hostnames.
            </InfoNote>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function IntegrationRow({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <div className="row-between">
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 550 }}>{name}</div>
        <div className="metric-label">{detail}</div>
      </div>
      <span className={`badge ${ok ? 'badge-good' : 'badge-warning'}`}>
        <span className={`dot ${ok ? 'dot-good' : 'dot-warning'}`} />
        {ok ? 'Connected' : 'Not configured'}
      </span>
    </div>
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
