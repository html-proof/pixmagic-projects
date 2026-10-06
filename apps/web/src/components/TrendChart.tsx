"use client";
import { useId, useState } from "react";

/** Single-series line chart (net sales per day) with crosshair tooltip and a table fallback. */
export function TrendChart({ series, format, label }: { series: Array<{ day: string; value: number }>; format: (n: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const gid = useId().replace(/:/g, "");
  if (series.length < 2) return null;
  const W = 640;
  const H = 180;
  const P = { l: 8, r: 8, t: 12, b: 22 };
  const max = Math.max(...series.map((s) => s.value), 0);
  const min = Math.min(...series.map((s) => s.value), 0);
  const x = (i: number) => P.l + (i / (series.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - min) / (max - min || 1)) * (H - P.t - P.b);
  const d = series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.value).toFixed(1)}`).join("");
  const h = hover !== null ? series[hover]! : null;

  return (
    <figure className="mt-4">
      <div className="flex items-center justify-between text-xs text-muted">
        <figcaption>{label}</figcaption>
        <button className="underline" onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show table"}</button>
      </div>
      {table ? (
        <table className="mt-2 w-full text-sm">
          <tbody>
            {series.map((s) => (
              <tr key={s.day} className="border-t border-border">
                <td className="py-1">{s.day}</td>
                <td className="py-1 text-right tabular-nums">{format(s.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="mt-2 w-full"
            role="img"
            aria-label={label}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const px = ((e.clientX - r.left) / r.width) * W;
              setHover(Math.max(0, Math.min(series.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (series.length - 1)))));
            }}
          >
            <defs>
              <linearGradient id={`trend-fill-${gid}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--chart)" stopOpacity="0.25" />
                <stop offset="100%" stopColor="var(--chart)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={`trend-line-${gid}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="var(--chart)" />
                <stop offset="100%" stopColor="var(--accent-2)" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1={P.l} x2={W - P.r} y1={P.t + f * (H - P.t - P.b)} y2={P.t + f * (H - P.t - P.b)} stroke="var(--border)" strokeDasharray="2 4" />
            ))}
            <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="var(--border)" />
            <path d={`${d}L${x(series.length - 1).toFixed(1)},${y(min).toFixed(1)}L${x(0).toFixed(1)},${y(min).toFixed(1)}Z`} fill={`url(#trend-fill-${gid})`} className="animate-fade" />
            <path d={d} fill="none" stroke={`url(#trend-line-${gid})`} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="animate-draw" />
            {h && hover !== null && (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="var(--muted)" strokeDasharray="3 3" />
                <circle cx={x(hover)} cy={y(h.value)} r={9} fill="var(--chart)" opacity={0.15} />
                <circle cx={x(hover)} cy={y(h.value)} r={4.5} fill="var(--chart)" stroke="var(--surface)" strokeWidth={2} />
              </>
            )}
            <text x={P.l} y={H - 4} fontSize="11" fill="var(--muted)">{series[0]!.day}</text>
            <text x={W - P.r} y={H - 4} fontSize="11" fill="var(--muted)" textAnchor="end">{series.at(-1)!.day}</text>
          </svg>
          {h && hover !== null && (
            <div className="pointer-events-none absolute top-0 rounded-md border border-border bg-surface px-2 py-1 text-xs shadow" style={{ left: `${(x(hover) / W) * 100}%`, transform: "translateX(-50%)" }}>
              <div className="text-muted">{h.day}</div>
              <div className="font-medium tabular-nums">{format(h.value)}</div>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
