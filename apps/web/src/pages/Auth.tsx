import { useEffect, useState, type FormEvent } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, ApiError } from '../lib/api';
import { ErrorNote, InfoNote } from '../components/ui';

/* --------------------------------------------------------------- login -- */

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [stage, setStage] = useState<'password' | 'second-factor'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [challengeId, setChallengeId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submitPassword = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.login(username.trim(), password);
      if (result.stage === 'complete') {
        // Enrolment is still outstanding; the shell routes them to it.
        onSignedIn();
        return;
      }
      setChallengeId(result.challengeId ?? '');
      setStage('second-factor');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitSecondFactor = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.loginVerify(
        challengeId,
        useRecovery ? { recoveryCode: recoveryCode.trim() } : { code: code.trim() },
      );
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted.');
      // A dead challenge means starting over rather than retrying forever.
      if (err instanceof ApiError && /expired/i.test(err.message)) {
        setStage('password');
        setPassword('');
      }
    } finally {
      setBusy(false);
    }
  };

  const usePasskey = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const options = await api.passkeyLoginOptions(challengeId);
      const assertion = await startAuthentication({ optionsJSON: options as never });
      await api.passkeyLoginVerify(challengeId, assertion);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That security key was not accepted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-mark" aria-hidden>◆</div>
        <h1 style={{ fontSize: 21, fontWeight: 640, letterSpacing: '-0.02em' }}>
          {stage === 'password' ? 'Sign in' : 'Two-factor authentication'}
        </h1>
        <p className="secondary small" style={{ marginTop: 5, marginBottom: 22 }}>
          {stage === 'password'
            ? 'Your personal cloud control centre.'
            : 'Enter the six-digit code from your authenticator app.'}
        </p>

        <ErrorNote>{error}</ErrorNote>

        {stage === 'password' ? (
          <form onSubmit={submitPassword}>
            <div className="field">
              <label className="field-label" htmlFor="username">Username</label>
              <input
                id="username"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button className="btn btn-primary btn-block" disabled={busy} style={{ marginTop: 6 }}>
              {busy ? <span className="spinner" /> : 'Continue'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitSecondFactor}>
            {useRecovery ? (
              <div className="field">
                <label className="field-label" htmlFor="recovery">Recovery code</label>
                <input
                  id="recovery"
                  className="input mono"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  autoFocus
                  required
                />
                <span className="field-hint">Each recovery code works only once.</span>
              </div>
            ) : (
              <div className="field">
                <label className="field-label" htmlFor="code">Authentication code</label>
                <input
                  id="code"
                  className="input input-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  autoFocus
                  required
                />
              </div>
            )}

            <button
              className="btn btn-primary btn-block"
              disabled={busy || (useRecovery ? recoveryCode.length < 8 : code.length !== 6)}
            >
              {busy ? <span className="spinner" /> : 'Sign in'}
            </button>

            <div className="btn-row" style={{ marginTop: 12, justifyContent: 'center' }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void usePasskey()} disabled={busy}>
                Use a passkey
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setError('');
                }}
              >
                {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- setup -- */

export function SetupPage({ onComplete }: { onComplete: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.setup({ username: username.trim(), displayName: displayName.trim(), password });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <div className="auth-mark" aria-hidden>◆</div>
        <h1 style={{ fontSize: 21, fontWeight: 640, letterSpacing: '-0.02em' }}>
          Create the owner account
        </h1>
        <p className="secondary small" style={{ marginTop: 5, marginBottom: 20 }}>
          This is the first and only time this page appears. You will set up two-factor
          authentication immediately afterwards.
        </p>

        <ErrorNote>{error}</ErrorNote>

        <form onSubmit={submit}>
          <div className="field">
            <label className="field-label" htmlFor="s-username">Username</label>
            <input
              id="s-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              pattern="[a-zA-Z0-9._\-]{3,40}"
              autoComplete="username"
              autoFocus
              required
            />
            <span className="field-hint">Letters, digits, dot, underscore and hyphen.</span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="s-display">Display name</label>
            <input
              id="s-display"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="s-password">Password</label>
            <input
              id="s-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
            <span className="field-hint">
              At least 12 characters. A memorable passphrase beats a short scramble.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="s-confirm">Confirm password</label>
            <input
              id="s-confirm"
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? <span className="spinner" /> : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ TOTP enrolment -- */

export function EnrollPage({ onComplete }: { onComplete: () => void }) {
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .totpBegin()
      .then((r) => {
        setSecret(r.secret);
        setQr(r.qr);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not start enrolment.'),
      );
  }, []);

  const confirm = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.totpConfirm(code.trim());
      // Shown exactly once — the server only keeps hashes.
      setRecoveryCodes(result.recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code did not match.');
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCodes) {
    return (
      <div className="auth-screen">
        <div className="auth-card" style={{ maxWidth: 460 }}>
          <h1 style={{ fontSize: 20, fontWeight: 640 }}>Save your recovery codes</h1>
          <p className="secondary small" style={{ marginTop: 6 }}>
            These are shown once and never again. Store them somewhere safe — a password
            manager, or printed and kept offline. Each one works a single time if you lose
            your authenticator.
          </p>

          <div className="recovery-grid">
            {recoveryCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>

          <div className="btn-row">
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(recoveryCodes.join('\n'));
                setCopied(true);
                setTimeout(() => setCopied(false), 2200);
              }}
            >
              {copied ? 'Copied' : 'Copy all'}
            </button>
            <button
              className="btn"
              onClick={() => {
                // A downloaded file is the fallback when clipboard access is blocked.
                const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'cloud-recovery-codes.txt';
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download
            </button>
            <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={onComplete}>
              I have saved them
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <h1 style={{ fontSize: 20, fontWeight: 640 }}>Set up two-factor authentication</h1>
        <p className="secondary small" style={{ marginTop: 6, marginBottom: 18 }}>
          Scan this with Aegis, 1Password, Bitwarden, Google Authenticator or any other
          TOTP app. This step is required — the platform stays locked until it is done.
        </p>

        <ErrorNote>{error}</ErrorNote>

        {qr ? (
          <div style={{ display: 'grid', placeItems: 'center', marginBottom: 16 }}>
            <img
              src={qr}
              alt="QR code for two-factor enrolment"
              width={200}
              height={200}
              style={{ borderRadius: 12, background: '#fff', padding: 8 }}
            />
          </div>
        ) : (
          <div className="skeleton" style={{ height: 200, marginBottom: 16 }} />
        )}

        {secret && (
          <div style={{ marginBottom: 16 }}>
            <InfoNote>
              Cannot scan? Enter this key by hand:
              <div className="mono" style={{ marginTop: 6, wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                {secret}
              </div>
            </InfoNote>
          </div>
        )}

        <form onSubmit={confirm}>
          <div className="field">
            <label className="field-label" htmlFor="enroll-code">
              Enter the code your app shows
            </label>
            <input
              id="enroll-code"
              className="input input-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              required
            />
          </div>
          <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>
            {busy ? <span className="spinner" /> : 'Verify and finish'}
          </button>
        </form>
      </div>
    </div>
  );
}
