import {
  useEffect, useRef, useState, type ReactNode, type FormEvent, type CSSProperties,
} from 'react';
import { api, ApiError } from '../lib/api';

/* --------------------------------------------------------------- panel -- */

export function Panel({
  title, action, children, className = '', bodyClass = '', style,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={`panel ${className}`} style={style}>
      {(title || action) && (
        <header className="panel-head">
          <h2 className="panel-title">{title}</h2>
          {action}
        </header>
      )}
      <div className={`panel-body ${bodyClass}`}>{children}</div>
    </section>
  );
}

/* ----------------------------------------------------------- stat tile -- */

export function StatTile({
  label, value, unit, caption, tone, icon,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  caption?: ReactNode;
  tone?: 'good' | 'warning' | 'critical';
  icon?: ReactNode;
}) {
  const toneColor =
    tone === 'critical' ? 'var(--critical)' : tone === 'warning' ? 'var(--warning)' : undefined;

  return (
    <div className="panel">
      <div className="panel-body">
        <div className="row-between" style={{ marginBottom: 10 }}>
          <span className="metric-label">{label}</span>
          {icon}
        </div>
        <div className="metric-value tabular" style={{ color: toneColor }}>
          {value}
          {unit && <span className="metric-unit">{unit}</span>}
        </div>
        {caption && (
          <div className="small secondary" style={{ marginTop: 6 }}>
            {caption}
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- modal -- */

export function Modal({
  open, title, onClose, children, width = 460,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Stop the page behind from scrolling while a dialog is open.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4, 6, 10, 0.68)',
        backdropFilter: 'blur(4px)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        zIndex: 100,
        animation: 'rise 140ms var(--ease)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: width,
          background: 'var(--surface-1)',
          border: '1px solid var(--hairline-strong)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-pop)',
          maxHeight: '86vh',
          overflowY: 'auto',
        }}
      >
        <header className="panel-head">
          <h2 style={{ fontSize: 15, fontWeight: 620 }}>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ step-up --- */

interface StepUpState {
  resolve: (ok: boolean) => void;
  reason: string;
}

/**
 * Destructive actions require a fresh authenticator code. This hook wraps any
 * action so the dialog appears only when the server actually demands it.
 */
export function useStepUp(): {
  dialog: ReactNode;
  guard: <T>(reason: string, action: () => Promise<T>) => Promise<T | undefined>;
} {
  const [pending, setPending] = useState<StepUpState | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const guard = async <T,>(reason: string, action: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await action();
    } catch (err) {
      // 403 with this code means the session needs a fresh second factor.
      if (!(err instanceof ApiError) || err.status !== 403) throw err;

      const confirmed = await new Promise<boolean>((resolve) => {
        setCode('');
        setError('');
        setPending({ resolve, reason });
      });
      if (!confirmed) return undefined;
      return action();
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.stepUp(code.trim());
      pending?.resolve(true);
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <Modal
      open={pending !== null}
      title="Confirm it's you"
      onClose={() => {
        pending?.resolve(false);
        setPending(null);
      }}
    >
      <p className="secondary" style={{ marginBottom: 16, fontSize: 13.5 }}>
        {pending?.reason} Enter the current code from your authenticator app to continue.
      </p>
      <form onSubmit={submit}>
        <input
          className="input input-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          aria-label="Authentication code"
        />
        {error && (
          <p style={{ color: 'var(--critical)', fontSize: 12.5, marginTop: 10 }}>{error}</p>
        )}
        <div className="btn-row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              pending?.resolve(false);
              setPending(null);
            }}
          >
            Cancel
          </button>
          <button className="btn btn-primary" disabled={code.length !== 6 || busy}>
            {busy ? <span className="spinner" /> : 'Confirm'}
          </button>
        </div>
      </form>
    </Modal>
  );

  return { dialog, guard };
}

/* ------------------------------------------------------------- confirm -- */

export function useConfirm(): {
  dialog: ReactNode;
  confirm: (options: { title: string; body: ReactNode; danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
} {
  const [state, setState] = useState<{
    title: string;
    body: ReactNode;
    danger?: boolean;
    confirmLabel?: string;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const confirm = (options: {
    title: string;
    body: ReactNode;
    danger?: boolean;
    confirmLabel?: string;
  }): Promise<boolean> =>
    new Promise((resolve) => setState({ ...options, resolve }));

  const close = (ok: boolean): void => {
    state?.resolve(ok);
    setState(null);
  };

  const dialog = (
    <Modal open={state !== null} title={state?.title ?? ''} onClose={() => close(false)}>
      <div className="secondary" style={{ fontSize: 13.5, marginBottom: 18 }}>
        {state?.body}
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={() => close(false)}>
          Cancel
        </button>
        <button
          className={`btn ${state?.danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => close(true)}
          autoFocus
        >
          {state?.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </Modal>
  );

  return { dialog, confirm };
}

/* -------------------------------------------------------------- toasts -- */

export function Toasts({
  notices, onDismiss,
}: {
  notices: { id: number; level: 'info' | 'warn' | 'error'; text: string }[];
  onDismiss: (id: number) => void;
}) {
  if (notices.length === 0) return null;

  const tone = (level: string): string =>
    level === 'error' ? 'var(--critical)' : level === 'warn' ? 'var(--warning)' : 'var(--accent)';
  const label = (level: string): string =>
    level === 'error' ? 'Error' : level === 'warn' ? 'Warning' : 'Info';

  return (
    <div
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        zIndex: 200,
        maxWidth: 380,
      }}
    >
      {notices.map((notice) => (
        <div
          key={notice.id}
          role="status"
          style={{
            background: 'var(--surface-raised)',
            backdropFilter: 'blur(10px)',
            border: '1px solid var(--hairline-strong)',
            borderLeft: `3px solid ${tone(notice.level)}`,
            borderRadius: 'var(--radius)',
            padding: '11px 14px',
            boxShadow: 'var(--shadow-pop)',
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            animation: 'rise 200ms var(--ease)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, fontWeight: 620, color: tone(notice.level) }}>
              {label(notice.level)}
            </div>
            <div style={{ fontSize: 13, marginTop: 2 }}>{notice.text}</div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onDismiss(notice.id)}
            aria-label="Dismiss"
            style={{ padding: '0 4px' }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- async state -- */

/** Loads data once and exposes a refresh, with error text ready for display. */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    loader()
      .then((value) => {
        if (!alive.current) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : 'Could not load this.');
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

/* --------------------------------------------------------------- misc --- */

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--critical) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--critical) 34%, transparent)',
        color: 'var(--critical)',
        borderRadius: 'var(--radius-sm)',
        padding: '9px 12px',
        fontSize: 13,
        marginBottom: 14,
      }}
      role="alert"
    >
      {children}
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius-sm)',
        padding: '11px 13px',
        fontSize: 13,
        color: 'var(--text-secondary)',
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty row" style={{ justifyContent: 'center', gap: 10 }}>
      <span className="spinner" />
      {label}
    </div>
  );
}

/** A labelled on/off switch. */
export function Toggle({
  checked, onChange, label, disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className="row"
      style={{ gap: 9, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
      />
      <span
        aria-hidden
        style={{
          width: 34,
          height: 19,
          borderRadius: 999,
          background: checked ? 'var(--accent)' : 'var(--surface-3)',
          position: 'relative',
          transition: 'background var(--fast) var(--ease)',
          flex: 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2.5,
            left: checked ? 17 : 2.5,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: checked ? 'var(--accent-ink)' : 'var(--text-secondary)',
            transition: 'left var(--fast) var(--ease)',
          }}
        />
      </span>
      <span style={{ fontSize: 13 }}>{label}</span>
    </label>
  );
}
