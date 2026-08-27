import {
  createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type {
  HostSnapshot, ContainerSummary, ProfileState, Transfer, UptimeCheck, Job,
  WsServerMessage,
} from '@cloud/shared';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

interface LiveState {
  connected: boolean;
  host: HostSnapshot | null;
  containers: ContainerSummary[];
  profile: ProfileState | null;
  transfers: Transfer[];
  uptime: UptimeCheck[];
  jobs: Job[];
  notices: Notice[];
  dismissNotice: (id: number) => void;
  pushNotice: (level: Notice['level'], text: string) => void;
}

const LiveContext = createContext<LiveState | null>(null);

/** How long history the sparklines keep from the live stream, in samples. */
const LIVE_WINDOW = 90;

let noticeSeq = 0;

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [host, setHost] = useState<HostSnapshot | null>(null);
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [uptime, setUptime] = useState<UptimeCheck[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const closedRef = useRef(false);

  const pushNotice = useMemo(
    () => (level: Notice['level'], text: string) => {
      const id = ++noticeSeq;
      setNotices((current) => [...current.slice(-4), { id, level, text }]);
      // Errors stay until dismissed; routine notices clear themselves.
      if (level !== 'error') {
        setTimeout(() => setNotices((c) => c.filter((n) => n.id !== id)), 6000);
      }
    },
    [],
  );

  const dismissNotice = useMemo(
    () => (id: number) => setNotices((current) => current.filter((n) => n.id !== id)),
    [],
  );

  useEffect(() => {
    closedRef.current = false;

    const connect = (): void => {
      if (closedRef.current) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/live`);
      socketRef.current = socket;

      socket.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
      };

      socket.onmessage = (event) => {
        let message: WsServerMessage;
        try {
          message = JSON.parse(event.data as string) as WsServerMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case 'host':
            setHost(message.data);
            break;
          case 'containers':
            setContainers(message.data);
            break;
          case 'profile':
            setProfile(message.data);
            break;
          case 'transfers':
            setTransfers(message.data);
            break;
          case 'uptime':
            setUptime(message.data);
            break;
          case 'jobs':
            setJobs(message.data);
            break;
          case 'notice':
            pushNotice(message.data.level, message.data.text);
            break;
        }
      };

      socket.onclose = (event) => {
        setConnected(false);
        socketRef.current = null;
        if (closedRef.current) return;
        // 4401 means the session is gone; reloading sends us to the login page.
        if (event.code === 4401) {
          window.location.reload();
          return;
        }
        // Back off, but keep trying — a laptop waking up should reconnect.
        const delay = Math.min(15_000, 700 * 2 ** retryRef.current++);
        setTimeout(connect, delay);
      };

      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      closedRef.current = true;
      socketRef.current?.close();
    };
  }, [pushNotice]);

  const value = useMemo<LiveState>(
    () => ({
      connected, host, containers, profile, transfers, uptime, jobs, notices,
      dismissNotice, pushNotice,
    }),
    [connected, host, containers, profile, transfers, uptime, jobs, notices, dismissNotice, pushNotice],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const context = useContext(LiveContext);
  if (!context) throw new Error('useLive must be used inside a LiveProvider');
  return context;
}

/**
 * Keeps a rolling in-memory series from the live stream, so every card can
 * show a sparkline without each one querying history separately.
 */
export function useLiveSeries(pick: (host: HostSnapshot) => number): number[] {
  const { host } = useLive();
  const [series, setSeries] = useState<number[]>([]);
  const lastAt = useRef(0);

  useEffect(() => {
    if (!host || host.at === lastAt.current) return;
    lastAt.current = host.at;
    const value = pick(host);
    if (!Number.isFinite(value)) return;
    setSeries((current) => {
      const next = [...current, value];
      return next.length > LIVE_WINDOW ? next.slice(next.length - LIVE_WINDOW) : next;
    });
    // `pick` is a fresh closure each render; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  return series;
}
