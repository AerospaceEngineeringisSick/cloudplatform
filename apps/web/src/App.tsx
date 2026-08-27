import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api, ApiError } from './lib/api';
import { LiveProvider, useLive } from './lib/live';
import { Sidebar, TopBar } from './components/shell';
import { Toasts, Loading } from './components/ui';
import { LoginPage, SetupPage, EnrollPage } from './pages/Auth';
import { OverviewPage } from './pages/Overview';
import { ComputePage } from './pages/Compute';
import { ContainersPage } from './pages/Containers';
import { MinecraftPage } from './pages/Minecraft';
import { StoragePage } from './pages/Storage';
import { MediaPage, CloudPage, DesktopsPage, NetworkPage } from './pages/Services';
import { MonitoringPage, JobsPage } from './pages/Monitoring';
import { LogsPage, SecurityPage, SettingsPage } from './pages/Admin';

type Phase = 'loading' | 'setup' | 'login' | 'enroll' | 'ready';

const THEME_KEY = 'cloud.theme';

function readTheme(): 'dark' | 'light' {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private browsing can throw on access; the default is fine.
  }
  return 'dark';
}

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [theme, setTheme] = useState<'dark' | 'light'>(readTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Not fatal — the choice simply will not persist.
    }
  }, [theme]);

  /** Works out which of setup, login, enrolment or the dashboard to show. */
  const resolvePhase = useCallback(async (): Promise<void> => {
    try {
      const me = await api.me();
      setPhase(me.mustEnrollTotp ? 'enroll' : 'ready');
      return;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        // A server that is not answering yet still needs a sign-in screen.
        setPhase('login');
        return;
      }
    }
    try {
      const state = await api.setupState();
      setPhase(state.needsSetup ? 'setup' : 'login');
    } catch {
      setPhase('login');
    }
  }, []);

  useEffect(() => {
    void resolvePhase();
  }, [resolvePhase]);

  if (phase === 'loading') {
    return (
      <div className="auth-screen">
        <Loading label="Connecting…" />
      </div>
    );
  }

  if (phase === 'setup') return <SetupPage onComplete={() => void resolvePhase()} />;
  if (phase === 'login') return <LoginPage onSignedIn={() => void resolvePhase()} />;
  if (phase === 'enroll') return <EnrollPage onComplete={() => void resolvePhase()} />;

  return (
    <LiveProvider>
      <Dashboard theme={theme} onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} />
    </LiveProvider>
  );
}

function Dashboard({
  theme, onToggleTheme,
}: {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}) {
  const { notices, dismissNotice } = useLive();
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
      <Sidebar onNavigate={() => setNavOpen(false)} />
      {navOpen && (
        <div className="nav-scrim" role="presentation" onClick={() => setNavOpen(false)} />
      )}

      <div className="app-main">
        <TopBar
          onOpenNav={() => setNavOpen((o) => !o)}
          theme={theme}
          onToggleTheme={onToggleTheme}
        />
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/compute" element={<ComputePage />} />
          <Route path="/containers" element={<ContainersPage />} />
          <Route path="/minecraft" element={<MinecraftPage />} />
          <Route path="/media" element={<MediaPage />} />
          <Route path="/cloud" element={<CloudPage />} />
          <Route path="/storage" element={<StoragePage />} />
          <Route path="/desktops" element={<DesktopsPage />} />
          <Route path="/network" element={<NetworkPage />} />
          <Route path="/monitoring" element={<MonitoringPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/security" element={<SecurityPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Unknown paths land on the overview rather than a dead end. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      <Toasts notices={notices} onDismiss={dismissNotice} />
    </div>
  );
}
