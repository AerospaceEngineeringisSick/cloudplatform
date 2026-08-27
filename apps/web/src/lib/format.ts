/** Presentation helpers. Everything the UI shows as a number passes through here. */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

export function bytes(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const sign = value < 0 ? '-' : '';
  let n = Math.abs(value);
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  // Whole bytes never need a decimal point.
  const places = unit === 0 ? 0 : n >= 100 ? 0 : digits;
  return `${sign}${n.toFixed(places)} ${UNITS[unit]}`;
}

/** Splits the value from its unit so the two can be styled differently. */
export function bytesParts(value: number | null | undefined, digits = 1): [string, string] {
  const formatted = bytes(value, digits);
  if (formatted === '—') return ['—', ''];
  const gap = formatted.lastIndexOf(' ');
  return [formatted.slice(0, gap), formatted.slice(gap + 1)];
}

export function bitsPerSecond(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return '—';
  const bits = bytesPerSec * 8;
  if (bits < 1000) return `${Math.round(bits)} bps`;
  if (bits < 1e6) return `${(bits / 1e3).toFixed(0)} Kbps`;
  if (bits < 1e9) return `${(bits / 1e6).toFixed(bits < 1e7 ? 1 : 0)} Mbps`;
  return `${(bits / 1e9).toFixed(2)} Gbps`;
}

export function percent(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function cores(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${s % 60}s`;
  return `${s}s`;
}

export function relativeTime(at: number | null | undefined): string {
  if (!at) return 'never';
  const delta = Date.now() - at;
  const future = delta < 0;
  const s = Math.floor(Math.abs(delta) / 1000);
  const format = (n: number, unit: string): string =>
    future ? `in ${n}${unit}` : `${n}${unit} ago`;
  if (s < 45) return future ? 'shortly' : 'just now';
  if (s < 3600) return format(Math.floor(s / 60), 'm');
  if (s < 86400) return format(Math.floor(s / 3600), 'h');
  if (s < 2592000) return format(Math.floor(s / 86400), 'd');
  return new Date(at).toLocaleDateString();
}

export function dateTime(at: number | null | undefined): string {
  if (!at) return '—';
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeOnly(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

/** Severity for a 0..1 utilisation, used to pick a status colour and label. */
export type Severity = 'good' | 'warning' | 'critical';

export function severityFor(ratio: number, warnAt = 0.75, criticalAt = 0.9): Severity {
  if (ratio >= criticalAt) return 'critical';
  if (ratio >= warnAt) return 'warning';
  return 'good';
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  good: 'Healthy',
  warning: 'Busy',
  critical: 'Critical',
};
