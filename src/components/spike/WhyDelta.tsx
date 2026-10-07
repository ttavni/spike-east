"use client";

// "We won the same game — why did they get more than me?"
//
// The honest answer has three parts: the scoreline the league expected (par), the scoreline
// that actually happened, and how many games the league already had on YOU. This panel is
// that answer, per player, opened from the number it's explaining. Everything here is read
// off `explainDelta` — no maths in the component, so it can't drift from the ladder.
//
// It describes what THIS game did, never how ratings work. The algorithm has no prose
// anywhere in the app and this is not the place to reintroduce it.

import { motion } from "motion/react";
import { explainDelta, WIN_MIN, type MatchEntry } from "@/lib/league";
import { C, SOFT } from "./ui";

/** Centre-anchored bar: left of centre means this dragged the swing down, right means up. */
function LiftBar({ lift }: { lift: number }) {
  const pct = Math.min(50, Math.abs(lift) * 50);
  const up = lift >= 0;
  return (
    <div style={{ position: "relative", height: 4, borderRadius: 99, background: "rgba(255,255,255,.07)", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,.18)" }} />
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={SOFT}
        style={{
          position: "absolute", top: 0, bottom: 0, borderRadius: 99,
          [up ? "left" : "right"]: "50%",
          background: up ? C.accent : "rgba(255,255,255,.25)",
        }}
      />
    </div>
  );
}

export function WhyDelta({ e, partner }: { e: MatchEntry; partner?: { entry: MatchEntry; name: string } }) {
  const b = explainDelta(e, partner);
  const dc = b.delta > 0 ? C.win : b.delta < 0 ? C.loss : C.dim;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={SOFT}
      style={{ overflow: "hidden" }}
    >
      <div style={{ background: C.panel, border: "1px solid rgba(255,255,255,.07)", borderRadius: 12, padding: "11px 12px", marginTop: 6 }}>
        {/* The verdict and the number it's explaining, on one line. */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.fg, lineHeight: 1.35 }}>{b.headline}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 17, fontWeight: 800, color: dc, flexShrink: 0 }}>
            {b.delta > 0 ? "+" : ""}{b.delta}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {b.factors.map((f) => (
            <div key={f.key}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, letterSpacing: ".03em", textTransform: "uppercase" }}>{f.label}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 800, color: C.num }}>{f.value}</span>
              </div>
              <LiftBar lift={f.lift} />
              <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.4, marginTop: 5 }}>{f.effect}</div>
            </div>
          ))}
        </div>

        {/* A small + on a big-favourite win reads like a bug. Say why where the number is. */}
        {b.underPar && (
          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.45, marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.06)" }}>
            Won, but under par. A win against a much weaker team only earns the minimum: +{WIN_MIN} for a win by two, more the bigger the margin.
          </div>
        )}

        {b.compare && (
          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.45, marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.06)" }}>
            {b.compare}
          </div>
        )}
      </div>
    </motion.div>
  );
}
