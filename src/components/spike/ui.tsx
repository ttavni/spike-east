"use client";

// The shared visual vocabulary: palette, motion language, and the small presentational
// pieces that more than one screen needs. Everything here is dumb — props in, pixels out,
// no league state. Lifted verbatim out of SpikeApp so new screens can reuse it instead of
// re-declaring their own `C` and `Avatar` (which is exactly what the old Tournament screen did).

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  useReducedMotion,
  useMotionValue,
  animate,
  type Transition,
} from "motion/react";
import { initial, tierOf, PROV_N, type PlayerStat } from "@/lib/league";

export const C = {
  bg: "#0C0E10", surface: "#15181B", panel: "#101316", raised: "#1B1F23",
  fg: "#F4F5F6", muted: "#8A9196", dim: "#6B7177", dimmer: "#5A6168",
  accent: "#CBFB4F", ink: "#0C0E10", win: "#5CD37D", loss: "#FF6B6B",
  gold: "#FFCF5C", silver: "#C4CDD6", bronze: "#E0935A",
  // The grey every mono figure in a table/stat row uses. Was hardcoded in ~8 places.
  num: "#9CA3A8",
};

/** The `.spk-press` opacity dip (globals.css) — tap feedback for plain buttons. */
export const press = "spk-press";

/** Highest losing score the score rail offers. The winner tracks loser+2, so 34 tops out
 *  at 36–34 — far past any real deuce, and inside the server's 0–99 bound. */
export const RAIL_MAX = 34;
/** px per rail tick; the rail reads its value back from scrollLeft / RAIL_TICK. */
export const RAIL_TICK = 44;

// Run layout work before paint, falling back to useEffect during SSR.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// ===== motion language =====
// One vocabulary of springs so everything moves like it came from the same hand.
// Snappy for taps, soft for content settling in, bouncy for the celebratory bits.
export const SPRING: Transition = { type: "spring", stiffness: 520, damping: 30, mass: 0.7 };
export const SOFT: Transition = { type: "spring", stiffness: 320, damping: 34 };
export const BOUNCE: Transition = { type: "spring", stiffness: 420, damping: 17, mass: 0.8 };
// Tap feedback: a small, immediate squish. Replaces the .spk-press opacity dip on motion elements.
export const tap = { whileTap: { scale: 0.95 }, transition: SPRING } as const;

// A list whose children fan in one after another, then animate to new slots on reorder.
export const listV = { animate: { transition: { staggerChildren: 0.045, delayChildren: 0.02 } } };
export const rowV = {
  initial: { opacity: 0, y: 14, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1, transition: SOFT },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.15 } },
};

// Count a number up to its target. Used for ratings + rating deltas so figures feel earned.
export function AnimatedNumber({
  value, from, format = (n) => String(n), duration = 0.55, style, className,
}: { value: number; from?: number; format?: (n: number) => string; duration?: number; style?: React.CSSProperties; className?: string }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(from ?? value);
  const [shown, setShown] = useState(from ?? value);
  useEffect(() => {
    if (reduce) { setShown(value); return; }
    const controls = animate(mv, value, {
      duration, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => setShown(Math.round(v)),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce]);
  return <span style={style} className={className}>{format(reduce ? value : shown)}</span>;
}

// Segmented control with a single highlight pill that slides between options (shared layoutId).
export function SegTabs<T extends string>({
  group, value, onChange, options,
}: { group: string; value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[] }) {
  return (
    <div style={{ display: "flex", background: C.panel, border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, padding: 4, marginBottom: 16 }}>
      {options.map(([v, label]) => {
        const on = value === v;
        return (
          <motion.button
            key={v} onClick={() => onChange(v)} whileTap={{ scale: 0.96 }}
            style={{ position: "relative", flex: 1, border: "none", background: "transparent", borderRadius: 9, padding: 9, fontSize: 12.5, fontWeight: 700, cursor: "pointer", color: on ? C.ink : C.muted, WebkitTapHighlightColor: "transparent" }}
          >
            {on && (
              <motion.span
                layoutId={`seg-${group}`} transition={SPRING}
                style={{ position: "absolute", inset: 0, background: C.accent, borderRadius: 9, zIndex: 0 }}
              />
            )}
            <span style={{ position: "relative", zIndex: 1, transition: "color .15s" }}>{label}</span>
          </motion.button>
        );
      })}
    </div>
  );
}

/**
 * A horizontally scrolling strip of player chips. Past a handful of players the current
 * pick is off the end of the strip, which reads as nothing being selected — so the chip
 * named by `focus` is scrolled to the middle whenever it changes. Children mark themselves
 * with `data-chip={id}`.
 *
 * scrollLeft rather than scrollIntoView: the latter can drag the whole page vertically
 * when the strip is below the fold (inside a sheet, say).
 */
export function ChipRow({ focus, children }: { focus?: string | null; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box || !focus) return;
    const chip = box.querySelector<HTMLElement>(`[data-chip="${CSS.escape(focus)}"]`);
    if (chip) box.scrollLeft = chip.offsetLeft - (box.clientWidth - chip.offsetWidth) / 2;
  }, [focus]);
  return (
    <div ref={ref} style={{ display: "flex", gap: 6, overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 3 }}>
      {children}
    </div>
  );
}

export function Avatar({ name, color, size = 34, ring, op = 1 }: { name: string; color: string; size?: number; ring?: string; op?: number }) {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%", background: color, color: C.ink,
        fontWeight: 800, fontSize: Math.round(size * 0.4), display: "flex", alignItems: "center",
        justifyContent: "center", flexShrink: 0, opacity: op,
        border: ring ? `2px solid ${ring}` : undefined,
      }}
    >
      {initial(name)}
    </div>
  );
}

export const medalC = (r?: number) => (r === 1 ? C.gold : r === 2 ? C.silver : r === 3 ? C.bronze : C.dim);

/** 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd". For the "likely 6th–11th" rank range. */
export function ordinal(n: number): string {
  const m100 = n % 100, m10 = n % 10;
  const suffix = m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** The rank line under a name: placing progress, or the rank with its likely range when known. */
export function rankLine(p: PlayerStat, final = false): string {
  if (!p.games) return "Unranked";
  if (p.provisional) return final ? `Didn't place · ${p.games}/${PROV_N} games` : `Placing · ${PROV_N - p.games} more`;
  if (!p.rank) return "Resting · rank returns next game";
  const rr = p.rankRange;
  if (rr && rr[0] !== rr[1]) return `#${p.rank} · likely ${ordinal(rr[0])}–${ordinal(rr[1])}`;
  return `#${p.rank} · ${p.games} game${p.games === 1 ? "" : "s"}`;
}

// Rank-tier badge. Built to survive the smallest screens: it never forces the row
// wider (maxWidth 100% + the label truncates with an ellipsis as a last resort) and
// the icon always stays visible. Callers put it on a flex-wrapping line so a long
// name (e.g. "Block-ness Monster") drops to its own line rather than overflowing.
export function TierChip({ rating, provisional, size = "sm" }: { rating: number; provisional: boolean; size?: "sm" | "md" }) {
  const t = tierOf(rating, provisional);
  const md = size === "md";
  return (
    <span
      title={`Rank: ${t.name}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: md ? 5 : 3,
        fontSize: md ? 11 : 9.5, fontWeight: 700, lineHeight: 1,
        color: t.color, background: `${t.color}1F`, border: `1px solid ${t.color}59`,
        borderRadius: 6, padding: md ? "3px 7px" : "2px 5px",
        maxWidth: "100%", overflow: "hidden", flexShrink: 0,
      }}
    >
      <span style={{ fontSize: md ? 12 : 10, flexShrink: 0 }}>{t.icon}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
    </span>
  );
}

export const segBg = (on: boolean) => (on ? C.accent : "transparent");
export const segTx = (on: boolean) => (on ? C.ink : C.muted);

// ---- small presentational helpers ----
export const iconBtn: React.CSSProperties = { background: C.surface, border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.fg, flexShrink: 0 };

// Tiny rating-trend sparkline. Pure SVG so it's cheap to render one per ladder row.
// Colour tracks momentum (green rising, red slipping) and the line draws itself in.
export function Sparkline({ hist, w = 56, h = 26 }: { hist: { r: number }[]; w?: number; h?: number }) {
  const id = useId();
  const reduce = useReducedMotion();
  const pts = hist.map((p) => p.r).slice(-10);
  if (pts.length < 2) return <div style={{ width: w, height: h, flexShrink: 0 }} />;
  const lo = Math.min(...pts), hi = Math.max(...pts), range = hi - lo || 1;
  const pad = 3, ih = h - pad * 2, stepX = w / (pts.length - 1);
  const xy = pts.map((r, i) => [i * stepX, pad + ih - ((r - lo) / range) * ih] as const);
  const line = xy.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
  const area = `${line} L${w.toFixed(1)},${h} L0,${h} Z`;
  const rising = pts[pts.length - 1] >= pts[0];
  const col = rising ? C.win : C.loss;
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flexShrink: 0, display: "block", overflow: "visible" }} aria-hidden>
      <defs>
        <linearGradient id={`sg-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity={0.22} />
          <stop offset="100%" stopColor={col} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sg-${id})`} />
      <motion.path
        d={line} fill="none" stroke={col} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
        initial={reduce ? false : { pathLength: 0, opacity: 0 }}
        animate={reduce ? undefined : { pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      />
      <circle cx={lx} cy={ly} r={3.4} fill={col} opacity={0.16} />
      <motion.circle cx={lx} cy={ly} r={1.9} fill={col}
        initial={reduce ? false : { opacity: 0 }} animate={reduce ? undefined : { opacity: 1 }}
        transition={{ delay: 0.55, duration: 0.3 }}
      />
    </svg>
  );
}

// Rank movement since the last session: ▲ climbed, ▼ slipped, NEW entry, – held.
export function RankDelta({ d }: { d?: number | "new" }) {
  if (d === undefined) return null;
  if (d === "new") return <span style={{ fontSize: 7.5, fontWeight: 800, color: C.accent, letterSpacing: ".02em", lineHeight: 1 }}>NEW</span>;
  if (d === 0) return <span style={{ fontSize: 10, color: C.dimmer, fontWeight: 700, lineHeight: 1 }}>–</span>;
  const up = d > 0;
  return (
    <span style={{ fontSize: 8.5, fontWeight: 800, color: up ? C.win : C.loss, lineHeight: 1, display: "flex", alignItems: "center", gap: 1 }}>
      <span style={{ fontSize: 7 }}>{up ? "▲" : "▼"}</span>{Math.abs(d)}
    </span>
  );
}

export function Pill({ id, A }: { id: string; A: (id: string) => PlayerStat }) {
  const p = A(id);
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, background: C.raised, borderRadius: 999, padding: "4px 9px 4px 4px" }}>
      <Avatar name={p.name} color={p.color} size={20} />
      <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
    </span>
  );
}

export function StatTile({ label, value, valueColor = C.fg, sub, suffix, onClick }: { label: string; value: string | number; valueColor?: string; sub?: string; suffix?: string; onClick?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={SOFT}
      onClick={onClick}
      style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: "13px 14px", cursor: onClick ? "pointer" : undefined }}
    >
      <div style={{ fontSize: 10.5, color: C.dim, fontWeight: 600, letterSpacing: ".04em" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 27, fontWeight: 800, color: valueColor, marginTop: 3 }}>
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}{suffix && <span style={{ fontSize: 16, color: C.dim }}>{suffix}</span>}
      </div>
      {sub && <div style={{ fontSize: 11, color: C.dim, fontFamily: "var(--font-mono)", marginTop: 1 }}>{sub}</div>}
    </motion.div>
  );
}

export function RelCard({ kind, color, id, A, sub, onClick }: { kind: string; color: string; id: string; A: (id: string) => PlayerStat; sub: string; onClick?: () => void }) {
  const p = A(id);
  return (
    <motion.div
      onClick={onClick}
      whileTap={onClick ? { scale: 0.98 } : undefined}
      style={{ background: C.surface, border: `1px solid ${color === C.win ? "rgba(92,211,125,.18)" : "rgba(255,107,107,.18)"}`, borderRadius: 14, padding: 13, cursor: onClick ? "pointer" : undefined }}
    >
      <div style={{ fontSize: 10, color, fontWeight: 700, letterSpacing: ".05em", marginBottom: 8 }}>{kind}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar name={p.name} color={p.color} size={30} /><span style={{ fontSize: 14, fontWeight: 700 }}>{p.name}</span></div>
      <div style={{ fontSize: 11.5, color: C.dim, fontFamily: "var(--font-mono)", marginTop: 7 }}>{sub}</div>
    </motion.div>
  );
}

export function NavBtn({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button onClick={onClick} whileTap={{ scale: 0.88 }} animate={{ color: active ? C.accent : C.dimmer }} transition={SPRING} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: 58, position: "relative" }}>
      <motion.span animate={{ scale: active ? 1.12 : 1, y: active ? -1 : 0 }} transition={SPRING} style={{ display: "flex" }}>{children}</motion.span>
      <span style={{ fontSize: 10, fontWeight: 600 }}>{label}</span>
    </motion.button>
  );
}

// Broadcast-style match card: a date column on the left, both teams stacked in the
// middle with their crest-pair avatars, and the scores in a tight right-aligned column
// so every card lines up down the list. Winner in lime, loser in white.
export function ResultRow({ m, resolve, onOpen }: { m: { teamA: string[]; teamB: string[]; scoreA: number; scoreB: number; date: string }; resolve: (id: string) => { name: string; color: string }; onOpen?: () => void }) {
  const aWon = m.scoreA > m.scoreB;
  const teams = [
    { ids: m.teamA, score: m.scoreA, won: aWon },
    { ids: m.teamB, score: m.scoreB, won: !aWon },
  ];
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={SOFT}
      whileTap={onOpen ? { scale: 0.98 } : undefined}
      onClick={onOpen}
      style={{ position: "relative", display: "flex", alignItems: "center", gap: 11, background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: "11px 13px", cursor: onOpen ? "pointer" : "default" }}
    >
      {/* date / status column */}
      <div style={{ width: 40, flexShrink: 0, textAlign: "center", fontSize: 10, fontWeight: 700, color: C.dim, letterSpacing: ".02em", lineHeight: 1.25 }}>{m.date}</div>
      {/* teams stacked */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {teams.map((t, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ display: "flex", flexShrink: 0 }}>
              {t.ids.map((id, j) => {
                const p = resolve(id);
                return <div key={id} style={{ marginLeft: j ? -7 : 0 }}><Avatar name={p.name} color={p.color} size={20} ring={C.surface} op={t.won ? 1 : 0.85} /></div>;
              })}
            </div>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: t.won ? 700 : 600, color: t.won ? C.accent : C.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.ids.map((id) => resolve(id).name).join(" & ")}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 800, color: t.won ? C.accent : C.fg, flexShrink: 0, minWidth: 26, textAlign: "right", lineHeight: 1 }}>{t.score}</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

/**
 * A collapsed row that opens in place. The `teaser` is the point: the page still says
 * something at a glance, and you only go deeper on the things you actually care about.
 */
export function Disclosure({
  title, teaser, defaultOpen = false, children,
}: { title: string; teaser?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={press}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "13px 14px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 700, color: C.fg }}>{title}</span>
        {teaser && <span style={{ fontSize: 12, color: C.dim, fontFamily: "var(--font-mono)", flexShrink: 0 }}>{teaser}</span>}
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING} style={{ display: "flex", color: C.dimmer, flexShrink: 0 }}>
          <Chevron dir="right" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: SOFT, opacity: { duration: 0.15 } }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "2px 14px 14px" }}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---- icons ----
export const sw = { fill: "none", stroke: "currentColor", strokeWidth: 2.1, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export function Chevron({ dir, color }: { dir: "left" | "right"; color?: string }) { return <svg width="18" height="18" viewBox="0 0 24 24" {...sw} style={{ color }}>{dir === "left" ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 18l6-6-6-6" />}</svg>; }
export function NetIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0C0E10" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>; }
export function EyeIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" {...sw}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>; }
export function LockIcon() { return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#CBFB4F" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>; }
export function InfoIcon({ size = 15 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" {...sw}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></svg>; }
export function EditIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" {...sw}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>; }
export function CopyIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" {...sw}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>; }
export function CrownIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="#FFCF5C" stroke="none"><path d="M5 16L3 5l5.5 4L12 4l3.5 5L21 5l-2 11H5z" /></svg>; }
export function CheckIcon({ size = 40 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#0C0E10" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>; }
export function RematchIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" {...sw} stroke="currentColor"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" /></svg>; }
export function LadderIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" {...sw}><path d="M16 18V8M12 18V4M8 18v-6M4 18v-2M2 21h20" /></svg>; }
export function MmIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" {...sw}><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>; }
export function PlusIcon() { return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0C0E10" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>; }
export function UserIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" {...sw}><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>; }
export function StatsIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" {...sw}><path d="M3 3v18h18" /><path d="M7 15l4-5 3 3 5-7" /></svg>; }

const glyph = { pointerEvents: "none" as const };
export function PlusSmall({ size = 18 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" style={glyph} {...sw}><path d="M12 5v14M5 12h14" /></svg>; }
export function CloseIcon({ size = 20 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" {...sw}><path d="M18 6L6 18M6 6l12 12" /></svg>; }
export function MinusSmall({ size = 18 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" style={glyph} {...sw}><path d="M5 12h14" /></svg>; }

/**
 * What the ratings said before a ball was hit, and whether the game defied it. Shared by
 * the match sheet and the post-log screen so an upset is described the same way in both.
 */
export function WinChanceBar({ probA, aWon, nameA, nameB }: { probA: number; aWon: boolean; nameA: string; nameB: string }) {
  const favA = probA >= 0.5;
  const favPct = Math.round((favA ? probA : 1 - probA) * 100);
  const even = Math.abs(probA - 0.5) < 0.02;
  const upset = favA !== aWon; // the favoured team didn't win
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 7 }}>Win chance before</div>
      {/* percentages flank the bar rather than sitting above it — one row instead of two */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 13, color: aWon ? C.accent : C.muted, width: 34 }}>{Math.round(probA * 100)}%</span>
        <div style={{ flex: 1, display: "flex", gap: 3, height: 7 }}>
          <div style={{ width: `${probA * 100}%`, background: aWon ? C.accent : C.dim, borderRadius: 4 }} />
          <div style={{ flex: 1, background: !aWon ? C.accent : C.dim, borderRadius: 4 }} />
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 13, color: !aWon ? C.accent : C.muted, width: 34, textAlign: "right" }}>{Math.round((1 - probA) * 100)}%</span>
      </div>
      <div style={{ fontSize: 11, color: upset && !even ? C.gold : C.dimmer, marginTop: 7, lineHeight: 1.35 }}>
        {even ? "An even matchup on paper." : `${favA ? nameA : nameB} favoured at ${favPct}% going in${upset ? " — upset!" : ""}.`}
      </div>
    </div>
  );
}

/**
 * Horizontal score picker: flick to any number in one gesture instead of tapping +
 * twenty times to reach a deuce. Snap-scrolling is the whole trick — the value is read
 * back from scrollLeft, so the browser's own momentum physics does the work.
 *
 * Every tick is also a real button, which keeps it usable with a mouse, a keyboard and a
 * screen reader without needing the +/− pair back.
 */
export function ScoreRail({ value, onChange, tint }: { value: number; onChange: (v: number) => void; tint: string }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);
  // Programmatic scrolls (declaring a winner, a plan prefill) must not be read back as if
  // the user had flicked — that would fight the caller's own value.
  const settling = useRef(false);
  const lastSent = useRef(value);
  // Mouse drag state. Touch is left to the browser's own momentum scrolling, which is far
  // better than anything we'd hand-roll; a mouse gets nothing from `overflow-x` on its own,
  // so on desktop the strip looked broken until we dragged it ourselves.
  const drag = useRef<{ id: number; x: number; from: number } | null>(null);

  const commit = (v: number) => {
    if (v === lastSent.current) return;
    lastSent.current = v;
    navigator.vibrate?.(8); // a tick under the thumb on Android; iOS ignores it
    onChange(v);
  };
  const nearest = () => {
    const el = ref.current;
    return el ? Math.max(0, Math.min(RAIL_MAX, Math.round(el.scrollLeft / RAIL_TICK))) : value;
  };
  const scrollTo = (v: number, smooth: boolean) => {
    const el = ref.current;
    if (!el) return;
    settling.current = true;
    lastSent.current = v;
    el.scrollTo({ left: v * RAIL_TICK, behavior: smooth && !reduce ? "smooth" : "auto" });
    // Let the smooth scroll finish before trusting scroll events again.
    window.setTimeout(() => { settling.current = false; }, smooth && !reduce ? 380 : 60);
  };
  /** A deliberate pick — tapping a tick, or releasing a drag. Tells the parent *first*, then
   *  animates: `scrollTo` alone would only ever reach the parent if the smooth scroll happened
   *  to outlast the settling guard, which it doesn't for a short hop to a neighbouring tick. */
  const pick = (v: number) => {
    if (v !== value) onChange(v);
    scrollTo(v, true);
  };

  // Follow the value when it changes from outside (winner declared, rematch, prefill).
  useEffect(() => {
    if (value !== lastSent.current) scrollTo(value, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  // Land on the current value on mount, before the first paint the user sees.
  useIsoLayoutEffect(() => { scrollTo(value, false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const onScroll = () => {
    if (settling.current) return;
    commit(nearest());
  };

  // ---- mouse drag (pointerType 'mouse' only, so touch keeps native scrolling) ----
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || !ref.current) return;
    e.preventDefault();
    drag.current = { id: e.pointerId, x: e.clientX, from: ref.current.scrollLeft };
    ref.current.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !ref.current) return;
    ref.current.scrollLeft = d.from - (e.clientX - d.x);
    commit(nearest()); // live, so the big score tracks the drag
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    // scroll-snap doesn't re-snap after scrollLeft is set by hand, so land it ourselves — and
    // commit where we landed, which can round to a different tick than the last pointermove.
    pick(nearest());
  };
  // A finger on the rail overrides any programmatic scroll still in flight; stop swallowing
  // scroll events or a flick started mid-animation would move the rail and not the score.
  const onTouchStart = () => { settling.current = false; };

  return (
    <div style={{ position: "relative" }}>
      {/* the selected tick sits under this caret */}
      <div style={{ position: "absolute", left: "50%", top: -2, transform: "translateX(-50%)", width: 2, height: 6, borderRadius: 2, background: C.accent, zIndex: 2 }} />
      <div
        ref={ref}
        onScroll={onScroll}
        onTouchStart={onTouchStart}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="spk-rail spk-noselect"
        style={{
          display: "flex", overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none",
          scrollSnapType: "x mandatory", touchAction: "pan-x", cursor: "grab",
          padding: `6px calc(50% - ${RAIL_TICK / 2}px)`,
          // fade the far ends so the strip reads as a dial rather than a cut-off list
          maskImage: "linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent)",
          WebkitMaskImage: "linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent)",
        }}
      >
        {Array.from({ length: RAIL_MAX + 1 }, (_, n) => {
          const on = n === value;
          return (
            <button
              key={n}
              onClick={() => pick(n)}
              aria-label={`Set ${n}`}
              style={{
                flex: `0 0 ${RAIL_TICK}px`, scrollSnapAlign: "center", height: 40,
                background: "none", border: "none", cursor: "pointer", padding: 0,
                fontFamily: "var(--font-mono)", fontSize: on ? 20 : 15,
                fontWeight: on ? 800 : 600, color: on ? tint : "#4A5056",
                transition: "color .15s, font-size .15s",
              }}
            >
              {n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A short burst for the person who just logged their own win. Deterministic fan (no
 *  Math.random, so a strict-mode double render doesn't re-roll it) and it self-dismisses. */
export function Confetti() {
  const reduce = useReducedMotion();
  const pieces = useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => {
        const a = (i * 137.5) % 360; // golden angle — scatters without clumping
        const r = 70 + ((i * 53) % 130);
        return {
          x: Math.cos((a * Math.PI) / 180) * r,
          y: Math.sin((a * Math.PI) / 180) * r,
          rot: (i * 71) % 360,
          color: [C.accent, C.win, C.gold, C.silver, "#FF9DD2"][i % 5],
          delay: (i % 6) * 0.03,
          w: 4 + (i % 3),
          dur: 1.4 + (i % 4) * 0.22,
        };
      }),
    [],
  );
  if (reduce) return null;
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1 }}>
      {pieces.map((p, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 1, x: 0, y: 0, scale: 0.5, rotate: 0 }}
          animate={{ opacity: 0, x: p.x, y: p.y + 200, scale: 1, rotate: p.rot }}
          transition={{ duration: p.dur, delay: p.delay, ease: [0.2, 0.6, 0.3, 1] }}
          style={{ position: "absolute", left: "50%", top: "50%", width: p.w, height: p.w * 1.8, borderRadius: 1.5, background: p.color }}
        />
      ))}
    </div>
  );
}
