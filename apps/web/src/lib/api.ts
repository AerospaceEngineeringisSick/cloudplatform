import type {
  User, SessionInfo, AuditEntry, HostSnapshot, HistorySeries, HistoryMetric, HistoryRange,
  ContainerSummary, ContainerLimits, Profile, ProfileState, ProfileId, ProfileApplyResult,
  StorageTierSummary, DirListing, Transfer, TieringSummary, JellyfinStatus, MinecraftStatus,
  UptimeCheck, Job, JobRun, LoginChallenge,
} from '@cloud/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    // Sessions are cookie-based; every call must carry them.
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text.slice(0, 300) };
  }

  if (!response.ok) {
    const err = payload as { error?: string; message?: string; retryAfterSec?: number };
    throw new ApiError(
      response.status,
      err.error ?? 'error',
      err.message ?? `Request failed with status ${response.status}`,
      err.retryAfterSec,
    );
  }

  return payload as T;
}

const get = <T>(path: string): Promise<T> => request<T>('GET', path);
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body);
const put = <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body);
const patch = <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body);
const del = <T>(path: string): Promise<T> => request<T>('DELETE', path);

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

export interface MeResponse {
  user: User;
  mustEnrollTotp: boolean;
  steppedUp: boolean;
  recoveryCodesRemaining: number;
}

export interface SettingsResponse {
  mounts: { id: string; label: string; mountpoint: string; tier: string }[];
  network: { iface: string; allowanceBytes: number; linkSpeedMbps: number | null };
  integrations: {
    jellyfin: boolean;
    minecraft: boolean;
    docker: boolean;
    rclone: string | null;
  };
  security: { stepUpWindowSec: number; requireStepUp: boolean; sessionTtlDays: number };
  origin: string;
}

export interface OverviewResponse {
  host: HostSnapshot | null;
  containers: ContainerSummary[];
  profile: ProfileState;
  uptime: UptimeCheck[];
  jellyfin: JellyfinStatus | null;
  minecraft: MinecraftStatus | null;
  dockerAvailable: boolean;
}

export interface ContainerDetail {
  summary: ContainerSummary;
  limits: ContainerLimits;
  env: string[];
  mounts: { source: string; destination: string; mode: string }[];
}

export const api = {
  /* ---------------------------------------------------------------- auth */
  setupState: () => get<{ needsSetup: boolean }>('/api/auth/setup-state'),
  setup: (input: { username: string; displayName: string; password: string }) =>
    post<{ user: User; mustEnrollTotp: boolean }>('/api/auth/setup', input),
  login: (username: string, password: string) =>
    post<LoginChallenge>('/api/auth/login', { username, password }),
  loginVerify: (challengeId: string, input: { code?: string; recoveryCode?: string }) =>
    post<{ user: User; recoveryCodesRemaining?: number }>('/api/auth/login/verify', {
      challengeId,
      ...input,
    }),
  passkeyLoginOptions: (challengeId: string) =>
    post<Record<string, unknown>>('/api/auth/login/passkey/options', { challengeId }),
  passkeyLoginVerify: (challengeId: string, response: unknown) =>
    post<{ user: User }>('/api/auth/login/passkey/verify', { challengeId, response }),
  me: () => get<MeResponse>('/api/auth/me'),
  logout: () => post<{ ok: boolean }>('/api/auth/logout'),
  stepUp: (code: string) => post<{ ok: boolean; until: number }>('/api/auth/step-up', { code }),

  totpBegin: () => post<{ secret: string; uri: string; qr: string }>('/api/auth/totp/begin'),
  totpConfirm: (code: string) =>
    post<{ ok: boolean; recoveryCodes: string[] }>('/api/auth/totp/confirm', { code }),
  totpReset: () => post<{ secret: string; uri: string; qr: string }>('/api/auth/totp/reset'),
  regenerateRecoveryCodes: () => post<{ codes: string[] }>('/api/auth/recovery-codes'),

  passkeys: () =>
    get<{ id: string; label: string; createdAt: number; lastUsedAt: number | null }[]>(
      '/api/auth/passkeys',
    ),
  passkeyBegin: () => post<Record<string, unknown>>('/api/auth/passkeys/begin'),
  passkeyFinish: (response: unknown, label: string) =>
    post<{ ok: boolean }>('/api/auth/passkeys/finish', { response, label }),
  passkeyDelete: (id: string) => del<{ ok: boolean }>(`/api/auth/passkeys/${id}`),

  sessions: () => get<SessionInfo[]>('/api/auth/sessions'),
  revokeSession: (id: string) => del<{ ok: boolean }>(`/api/auth/sessions/${id}`),
  changePassword: (current: string, next: string) =>
    post<{ ok: boolean; otherSessionsRevoked: number }>('/api/auth/password', { current, next }),

  users: () => get<User[]>('/api/users'),
  createUser: (input: { username: string; displayName: string; password: string; role: string }) =>
    post<User>('/api/users', input),
  deleteUser: (id: string) => del<{ ok: boolean }>(`/api/users/${id}`),
  audit: (limit = 200, before?: number) =>
    get<AuditEntry[]>(`/api/audit${query({ limit, before })}`),

  /* -------------------------------------------------------------- system */
  overview: () => get<OverviewResponse>('/api/overview'),
  host: () => get<HostSnapshot>('/api/host'),
  history: (metric: HistoryMetric, range: HistoryRange) =>
    get<HistorySeries>(`/api/host/history${query({ metric, range })}`),
  settings: () => get<SettingsResponse>('/api/settings'),

  /* ---------------------------------------------------------- containers */
  containers: () => get<ContainerSummary[]>('/api/containers'),
  container: (id: string) => get<ContainerDetail>(`/api/containers/${id}`),
  containerLogs: (id: string, lines = 300) =>
    get<{ logs: string }>(`/api/containers/${id}/logs${query({ lines })}`),
  containerAction: (id: string, action: 'start' | 'stop' | 'restart') =>
    post<{ ok: boolean }>(`/api/containers/${id}/${action}`),
  setLimits: (id: string, limits: Partial<ContainerLimits>) =>
    put<ContainerDetail>(`/api/containers/${id}/limits`, limits),

  /* ------------------------------------------------------------ profiles */
  profiles: () => get<{ profiles: Profile[]; state: ProfileState }>('/api/profiles'),
  applyProfile: (id: ProfileId) => post<ProfileApplyResult>(`/api/profiles/${id}/apply`),
  saveCustomProfile: (profile: Profile) => put<Profile>('/api/profiles/custom', profile),

  /* ------------------------------------------------------------- storage */
  tiers: () => get<StorageTierSummary[]>('/api/storage/tiers'),
  listDir: (mount: string, path: string) =>
    get<DirListing>(`/api/storage/list${query({ mount, path })}`),
  dirSize: (mount: string, path: string) =>
    get<{ bytes: number; files: number; complete: boolean }>(
      `/api/storage/size${query({ mount, path })}`,
    ),
  downloadUrl: (mount: string, path: string) => `/api/storage/download${query({ mount, path })}`,
  createFolder: (mount: string, path: string, name: string) =>
    post<{ ok: boolean }>('/api/storage/folder', { mount, path, name }),
  rename: (mount: string, path: string, name: string) =>
    post<{ ok: boolean }>('/api/storage/rename', { mount, path, name }),
  remove: (mount: string, path: string) =>
    post<{ ok: boolean }>('/api/storage/delete', { mount, path }),

  transfers: () => get<Transfer[]>('/api/transfers'),
  startTransfer: (input: {
    kind: 'move' | 'copy';
    sourceMount: string;
    sourcePath: string;
    destMount: string;
    destPath: string;
  }) => post<Transfer>('/api/transfers', input),
  cancelTransfer: (id: string) => del<{ ok: boolean }>(`/api/transfers/${id}`),

  tiering: () =>
    get<{ summary: TieringSummary; rules: Record<string, unknown> }>('/api/storage/tiering'),
  saveTiering: (rules: Record<string, unknown>) =>
    put<Record<string, unknown>>('/api/storage/tiering', rules),

  /* ------------------------------------------------------------ services */
  jellyfin: () => get<JellyfinStatus>('/api/jellyfin'),
  jellyfinRescan: () => post<{ ok: boolean }>('/api/jellyfin/rescan'),
  jellyfinRestart: () => post<{ ok: boolean }>('/api/jellyfin/restart'),

  minecraft: () => get<MinecraftStatus>('/api/minecraft'),
  minecraftStart: () => post<{ ok: boolean }>('/api/minecraft/start'),
  minecraftStop: () => post<{ ok: boolean }>('/api/minecraft/stop'),
  minecraftRestart: () => post<{ ok: boolean }>('/api/minecraft/restart'),
  minecraftBackup: () =>
    post<{ transferId: string; destination: string }>('/api/minecraft/backup'),
  minecraftCommand: (command: string) =>
    post<{ output: string }>('/api/minecraft/command', { command }),

  /* -------------------------------------------------------------- uptime */
  uptime: () => get<UptimeCheck[]>('/api/uptime'),
  createCheck: (input: { name: string; kind: string; target: string }) =>
    post<UptimeCheck>('/api/uptime', input),
  deleteCheck: (id: string) => del<{ ok: boolean }>(`/api/uptime/${id}`),
  setCheckEnabled: (id: string, enabled: boolean) =>
    patch<{ ok: boolean }>(`/api/uptime/${id}`, { enabled }),

  /* ---------------------------------------------------------------- jobs */
  jobs: () => get<Job[]>('/api/jobs'),
  jobRuns: (id: string) => get<JobRun[]>(`/api/jobs/${id}/runs`),
  runJob: (id: string) => post<JobRun>(`/api/jobs/${id}/run`),
  setJobEnabled: (id: string, enabled: boolean) =>
    patch<{ ok: boolean }>(`/api/jobs/${id}`, { enabled }),
};
