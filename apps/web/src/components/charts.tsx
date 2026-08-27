import { useId, useMemo, useState, type ReactNode } from 'react';
import { bytes, percent, severityFor, type Severity } from '../lib/format';

/*
 * Chart primitives.
 *
 * Rules held throughout: thin marks, recessive grid and axes, values always
 * available as text (never colour alone), a legend whenever two or more series
 * share a plot, and one shared y-scale per plot — never a second axis.
 */

const STATUS_VAR: Record<Severity, string> = {
  good: 'var(--good)',
  warning: 'var(--warning)',
  critical: 'var(--critical)',
};

/* --------------------------------------------------------------- gauge -- */

export interface GaugeProps {
  /** 0..1 */
  value: number;
  label: string;
  /** The headline figure, already formatted. */
  display: string;
  unit?: string;
  caption?: string;
  size?: number;
  /** Colour by utilisation severity rather than identity. */
  severity?: Severity;
}

/**
 * A radial arc meter. The number in the middle is the real reading; the arc is
 * a secondary cue, so the card still works for a colourblind reader.
 */
export function Gauge({
  value, label, display, unit, caption, size = 132, severity,
}: GaugeProps) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const tone = severity ?? severityFor(clamped);
  const stroke = 9;
  const radius = (size - stroke) / 2;
  // A 270° sweep starting bottom-left reads as a dial rather than a pie.
  const sweep = 270;
  const circumference = 2 * Math.PI * radius;
  const arcLength = (sweep / 360) * circumference;
  const filled = arcLength * clamped;

  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`${label}: ${display}${unit ? ` ${unit}` : ''}`}
          style={{ transform: 'rotate(135deg)' }}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--surface-3)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arcLength} ${circumference}`}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={STATUS_VAR[tone]}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
            style={{ transition: 'stroke-dasharray 400ms var(--ease), stroke 400ms var(--ease)' }}
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
          }}
        >
          <div style={{ fontSize: size > 120 ? 26 : 21, fontWeight: 630, letterSpacing: '-0.03em' }}>
            {display}
            {unit && <span className="metric-unit">{unit}</span>}
          </div>
          {caption && (
            <div className="metric-label" style={{ fontSize: 11 }}>
              {caption}
            </div>
          )}
        </div>
      </div>
      <figcaption
        style={{
          marginTop: 8,
          fontSize: 12.5,
          fontWeight: 560,
          color: 'var(--text-secondary)',
          textAlign: 'center',
        }}
      >
        {label}
      </figcaption>
    </figure>
  );
}

/* ----------------------------------------------------------- sparkline -- */

export interface SparklineProps {
  data: number[];
  /** Fixed upper bound; omit to scale to the data. */
  max?: number;
  color?: string;
  height?: number;
  /** Formats the hovered value for the tooltip. */
  format?: (value: number) => string;
  label?: string;
}

/** A compact trend line with a hover readout. */
export function Sparkline({
  data, max, color = 'var(--series-1)', height = 46, format = (v) => v.toFixed(2), label,
}: SparklineProps) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const { path, area, top, points } = useMemo(() => {
    if (data.length < 2) return { path: '', area: '', top: 1, points: [] as [number, number][] };
    const ceiling = max ?? Math.max(...data, 0.0001) * 1.15;
    const width = 100;
    const step = width / (data.length - 1);
    const coords: [number, number][] = data.map((value, index) => {
      const x = index * step;
      const y = height - Math.min(1, value / ceiling) * height;
      return [x, y];
    });
    const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    const filled = `${line} L100,${height} L0,${height} Z`;
    return { path: line, area: filled, top: ceiling, points: coords };
  }, [data, max, height]);

  if (data.length < 2) {
    return (
      <div
        style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        className="metric-label"
      >
        collecting…
      </div>
    );
  }

  const hovered = hover !== null ? data[hover] : undefined;

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block', overflow: 'visible' }}
        role="img"
        aria-label={label ? `${label} trend` : 'trend'}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          setHover(Math.min(data.length - 1, Math.max(0, Math.round(ratio * (data.length - 1)))));
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {hover !== null && points[hover] && (
          <>
            <line
              x1={points[hover]![0]}
              y1={0}
              x2={points[hover]![0]}
              y2={height}
              stroke="var(--baseline)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={points[hover]![0]}
              cy={points[hover]![1]}
              r="3.5"
              fill={color}
              stroke="var(--surface-1)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      {hovered !== undefined && (
        <div
          style={{
            position: 'absolute',
            top: -6,
            right: 0,
            background: 'var(--surface-3)',
            border: '1px solid var(--hairline-strong)',
            borderRadius: 6,
            padding: '2px 7px',
            fontSize: 11.5,
            fontVariantNumeric: 'tabular-nums',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {format(hovered)}
        </div>
      )}
      <span style={{ display: 'none' }}>{top}</span>
    </div>
  );
}

/* --------------------------------------------------------- area chart --- */

export interface Series {
  name: string;
  color: string;
  data: { t: number; v: number }[];
}

export interface AreaChartProps {
  series: Series[];
  height?: number;
  format?: (value: number) => string;
  /** Shared upper bound; all series use one scale — never a second axis. */
  max?: number;
  yTicks?: number;
}

/** A multi-series line chart with a crosshair and a shared tooltip. */
export function AreaChart({
  series, height = 200, format = (v) => v.toFixed(2), max, yTicks = 4,
}: AreaChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();

  const usable = series.filter((s) => s.data.length > 1);
  const length = Math.max(0, ...usable.map((s) => s.data.length));

  const ceiling = useMemo(() => {
    if (max !== undefined) return max;
    const peak = Math.max(0.0001, ...usable.flatMap((s) => s.data.map((p) => p.v)));
    return peak * 1.15;
  }, [usable, max]);

  if (usable.length === 0 || length < 2) {
    return <div className="empty">Not enough data collected yet.</div>;
  }

  const width = 100;
  const paths = usable.map((s) => {
    const step = width / (s.data.length - 1);
    const line = s.data
      .map((point, index) => {
        const x = index * step;
        const y = height - Math.min(1, point.v / ceiling) * height;
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
    return { series: s, line, area: `${line} L100,${height} L0,${height} Z`, step };
  });

  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => (ceiling / yTicks) * i);
  const primary = usable[0]!;
  const hoverIndex = hover !== null ? Math.min(hover, primary.data.length - 1) : null;

  return (
    <figure style={{ margin: 0 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        {/* Axis labels are ink, never a series colour. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column-reverse',
            justifyContent: 'space-between',
            height,
            fontSize: 10.5,
            color: 'var(--text-muted)',
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
            minWidth: 46,
            flex: 'none',
          }}
        >
          {ticks.map((tick, i) => (
            <span key={i}>{format(tick)}</span>
          ))}
        </div>

        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <svg
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            style={{ width: '100%', height, display: 'block' }}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientX - rect.left) / rect.width;
              setHover(
                Math.min(primary.data.length - 1, Math.max(0, Math.round(ratio * (primary.data.length - 1)))),
              );
            }}
          >
            <defs>
              {paths.map(({ series: s }, i) => (
                <linearGradient key={i} id={`${gradientId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={usable.length > 1 ? 0.16 : 0.26} />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              ))}
            </defs>

            {ticks.map((_, i) => {
              const y = height - (height / yTicks) * i;
              return (
                <line
                  key={i}
                  x1="0"
                  y1={y}
                  x2="100"
                  y2={y}
                  stroke={i === 0 ? 'var(--baseline)' : 'var(--grid)'}
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {paths.map(({ series: s, area }, i) => (
              <path key={`a-${i}`} d={area} fill={`url(#${gradientId}-${i})`} />
            ))}
            {paths.map(({ series: s, line }, i) => (
              <path
                key={`l-${i}`}
                d={line}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {hoverIndex !== null && (
              <line
                x1={(100 / (primary.data.length - 1)) * hoverIndex}
                y1="0"
                x2={(100 / (primary.data.length - 1)) * hoverIndex}
                y2={height}
                stroke="var(--baseline)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {hoverIndex !== null &&
              paths.map(({ series: s }, i) => {
                const point = s.data[Math.min(hoverIndex, s.data.length - 1)];
                if (!point) return null;
                return (
                  <circle
                    key={`p-${i}`}
                    cx={(100 / (s.data.length - 1)) * Math.min(hoverIndex, s.data.length - 1)}
                    cy={height - Math.min(1, point.v / ceiling) * height}
                    r="3.5"
                    fill={s.color}
                    stroke="var(--surface-1)"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
          </svg>

          {hoverIndex !== null && primary.data[hoverIndex] && (
            <div
              style={{
                position: 'absolute',
                top: 4,
                left: hoverIndex > primary.data.length / 2 ? 8 : undefined,
                right: hoverIndex > primary.data.length / 2 ? undefined : 8,
                background: 'var(--surface-raised)',
                backdropFilter: 'blur(8px)',
                border: '1px solid var(--hairline-strong)',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                pointerEvents: 'none',
                boxShadow: 'var(--shadow-pop)',
                minWidth: 132,
              }}
            >
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>
                {new Date(primary.data[hoverIndex]!.t).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </div>
              {usable.map((s) => {
                const point = s.data[Math.min(hoverIndex, s.data.length - 1)];
                return (
                  <div key={s.name} className="row-between" style={{ gap: 14 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <span
                        style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flex: 'none' }}
                      />
                      <span style={{ color: 'var(--text-secondary)' }}>{s.name}</span>
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {point ? format(point.v) : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Two or more series always carry a legend. */}
      {usable.length > 1 && (
        <figcaption style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap', paddingLeft: 56 }}>
          {usable.map((s) => (
            <span key={s.name} className="row" style={{ gap: 6, fontSize: 12 }}>
              <span style={{ width: 10, height: 3, borderRadius: 2, background: s.color, flex: 'none' }} />
              <span style={{ color: 'var(--text-secondary)' }}>{s.name}</span>
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

/* ---------------------------------------------------------------- meter -- */

export interface MeterProps {
  value: number;
  total: number;
  label: string;
  color?: string;
  /** Renders the used/total figures beside the bar. */
  showFigures?: boolean;
  right?: ReactNode;
  height?: number;
}

/** A horizontal fill bar with its value always spelled out in text. */
export function Meter({
  value, total, label, color, showFigures = true, right, height = 8,
}: MeterProps) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  const tone = severityFor(ratio, 0.8, 0.92);
  const fill = color ?? STATUS_VAR[tone];

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 550 }}>{label}</span>
        {right ?? (
          showFigures && (
            <span className="small tabular muted">
              {bytes(value)} / {bytes(total)} · {percent(ratio)}
            </span>
          )
        )}
      </div>
      <div
        style={{
          height,
          borderRadius: height / 2,
          background: 'var(--surface-3)',
          overflow: 'hidden',
        }}
        role="meter"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          style={{
            width: `${ratio * 100}%`,
            height: '100%',
            background: fill,
            borderRadius: height / 2,
            transition: 'width 500ms var(--ease), background 300ms var(--ease)',
          }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------ stacked tiers ---- */

export interface StackSegment {
  label: string;
  value: number;
  color: string;
}

/** A single stacked bar, used for the hot/warm/cold storage split. */
export function StackedBar({ segments, height = 14 }: { segments: StackSegment[]; height?: number }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return <div className="empty">No storage data yet.</div>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 2, height, borderRadius: height / 2, overflow: 'hidden' }}>
        {segments.map((segment) => (
          <div
            key={segment.label}
            title={`${segment.label}: ${bytes(segment.value)}`}
            style={{
              width: `${(segment.value / total) * 100}%`,
              background: segment.color,
              transition: 'width 500ms var(--ease)',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
        {segments.map((segment) => (
          <span key={segment.label} className="row" style={{ gap: 7 }}>
            <span
              style={{ width: 9, height: 9, borderRadius: 2, background: segment.color, flex: 'none' }}
            />
            <span style={{ fontSize: 12.5 }}>
              <span style={{ color: 'var(--text-secondary)' }}>{segment.label}</span>{' '}
              <span className="tabular">{bytes(segment.value)}</span>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- uptime bars --- */

/**
 * One bar per day over 30 days. Colour carries severity, but the tooltip and
 * the percentage beside it carry the actual number.
 */
export function UptimeBars({ history }: { history: (number | null)[] }) {
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 26 }}>
      {history.map((day, index) => {
        const daysAgo = history.length - 1 - index;
        const when = daysAgo === 0 ? 'today' : `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`;
        if (day === null) {
          return (
            <div
              key={index}
              title={`${when}: no data`}
              style={{
                flex: 1,
                height: '38%',
                background: 'var(--surface-3)',
                borderRadius: 2,
                minWidth: 3,
              }}
            />
          );
        }
        const tone: Severity = day >= 0.999 ? 'good' : day >= 0.95 ? 'warning' : 'critical';
        return (
          <div
            key={index}
            title={`${when}: ${percent(day, 2)} up`}
            style={{
              flex: 1,
              height: `${38 + day * 62}%`,
              background: STATUS_VAR[tone],
              borderRadius: 2,
              minWidth: 3,
              transition: 'height 300ms var(--ease)',
            }}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- per-core -- */

/** Four vCPUs is few enough to show each one individually. */
export function CoreBars({ perCore }: { perCore: number[] }) {
  if (perCore.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {perCore.map((usage, index) => {
        const tone = severityFor(usage);
        return (
          <div key={index} style={{ flex: 1, textAlign: 'center' }}>
            <div
              style={{
                height: 44,
                background: 'var(--surface-3)',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'flex-end',
                overflow: 'hidden',
              }}
              title={`Core ${index}: ${percent(usage)}`}
            >
              <div
                style={{
                  width: '100%',
                  height: `${Math.min(100, usage * 100)}%`,
                  background: STATUS_VAR[tone],
                  transition: 'height 400ms var(--ease)',
                }}
              />
            </div>
            <div className="metric-label tabular" style={{ marginTop: 5, fontSize: 10.5 }}>
              {percent(usage)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
