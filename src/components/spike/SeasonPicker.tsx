"use client";

// The season switch in the header, naming the view you're on and opening a short menu of the
// others. On the league's own screens it IS the header title ("● Season 2 ⌄"), so the header
// stays one clean line; on a profile or Me it's a small pill beside the title. Words kept to a
// minimum: the season in progress gets a LIVE tag, and every option is just dates and games.

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { C, SOFT, press } from "./ui";
import { LEAGUE_TZ } from "@/lib/day";
import { scopeKey, seasonName, type Scope, type Season } from "@/lib/season";

const fmt = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: LEAGUE_TZ });

function LiveDot({ size = 6 }: { size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: 99, background: C.accent, boxShadow: "0 0 0 3px rgba(203,251,79,.16)", flexShrink: 0 }} />;
}

function LiveTag() {
  return (
    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".08em", color: C.ink, background: C.accent, borderRadius: 4, padding: "2px 5px", lineHeight: 1 }}>
      LIVE
    </span>
  );
}

export function SeasonPicker({
  seasons, value, games, firstGame, onChange, variant = "pill",
}: {
  seasons: Season[];
  value: Scope;
  /** Games in each view, by scopeKey. */
  games: Record<string, number>;
  /** When the league's first game was played: where Season 1's dates begin. */
  firstGame?: number;
  onChange: (scope: Scope) => void;
  /** "title": the header's title itself. "pill": a small control beside another title. */
  variant?: "title" | "pill";
}) {
  const asTitle = variant === "title";
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const live = value !== "all" && seasons.find((s) => s.n === value)?.end === null;
  const count = (scope: Scope) => {
    const n = games[scopeKey(scope)] ?? 0;
    return `${n} game${n === 1 ? "" : "s"}`;
  };
  const options = [
    ...[...seasons].reverse().map((s) => {
      const from = s.start || firstGame;
      // `end` is the next season's first moment, so the last day of this one is the day before.
      const to = s.end === null ? "now" : fmt(s.end - 1);
      return {
        scope: s.n as Scope,
        title: seasonName(s.n),
        live: s.end === null,
        sub: `${from ? `${fmt(from)} – ` : "– "}${to} · ${count(s.n)}`,
      };
    }),
    { scope: "all" as Scope, title: "All time", live: false, sub: count("all") },
  ];

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={press}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Showing ${value === "all" ? "All time" : seasonName(value)}. Change season`}
        style={asTitle
          ? { height: 34, display: "flex", alignItems: "center", gap: 8, padding: 0, background: "none", border: "none", color: C.fg, fontSize: 20, fontWeight: 800, letterSpacing: "-.02em", cursor: "pointer", whiteSpace: "nowrap" }
          : { height: 34, display: "flex", alignItems: "center", gap: 7, padding: "0 9px 0 11px", borderRadius: 10, background: C.surface, border: "1px solid rgba(255,255,255,.07)", color: C.fg, fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
      >
        {live && <LiveDot size={asTitle ? 8 : 6} />}
        {value === "all" ? "All time" : seasonName(value)}
        <motion.svg animate={{ rotate: open ? 180 : 0 }} transition={SOFT} width={asTitle ? 17 : 13} height={asTitle ? 17 : 13} viewBox="0 0 24 24" fill="none" stroke={C.dim} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block", marginTop: asTitle ? 2 : 0 }}>
          <path d="M6 9l6 6 6-6" />
        </motion.svg>
      </button>

      {/* Any tap outside closes it, and doesn't also land on whatever was underneath. */}
      {open && <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 58 }} />}
      <AnimatePresence>
        {open && (
          <motion.div
            key="menu"
            role="menu"
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
            transition={SOFT}
            style={{ position: "absolute", top: "calc(100% + 8px)", ...(asTitle ? { left: 0 } : { right: 0 }), zIndex: 60, width: 236, transformOrigin: asTitle ? "top left" : "top right", background: "#16191C", border: "1px solid rgba(255,255,255,.1)", borderRadius: 14, padding: 5, boxShadow: "0 18px 44px rgba(0,0,0,.55)" }}
          >
            {options.map((o) => {
              const on = o.scope === value;
              return (
                <button
                  key={String(o.scope)}
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => { onChange(o.scope); setOpen(false); }}
                  className={press}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", background: on ? "rgba(203,251,79,.07)" : "none", border: "none", borderRadius: 10, textAlign: "left", cursor: "pointer" }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 700, color: on ? C.accent : C.fg }}>
                      {o.title}
                      {o.live && <LiveTag />}
                    </span>
                    <span style={{ display: "block", fontSize: 11, color: C.dim, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.sub}</span>
                  </span>
                  {on && (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
