"use client";

// GitHub-contributions grid, but coloured by *result* rather than volume: a winning day
// glows lime-green, a losing day red, and a break-even day sits neutral. Intensity tracks
// how many games you got in, so a five-game clean sweep reads louder than a single win.
//
// Deliberately plain <div>s with no per-cell motion — there are ~180 of them and animating
// each one is visible jank on a phone. The whole grid fades in as one instead.

import { motion } from "motion/react";
import { C } from "@/components/spike/ui";
import type { ActivityGrid, GridCell } from "@/lib/league";

const CELL = 10;
const GAP = 2;

/** Empty days sit just above the card background; played days ramp toward their result colour. */
function cellStyle(c: GridCell, max: number): React.CSSProperties {
  if (!c.inRange) return { background: "transparent" };
  if (c.games === 0) return { background: "rgba(255,255,255,.045)" };
  // 0.35 floor so a single game is still clearly "played", not a smudge.
  const weight = 0.35 + 0.65 * (max > 1 ? (c.games - 1) / (max - 1) : 1);
  const net = c.wins - c.losses;
  if (net === 0) return { background: `rgba(138,145,150,${(0.3 + 0.5 * weight).toFixed(3)})` };
  const [r, g, b] = net > 0 ? [92, 211, 125] : [255, 107, 107];
  return { background: `rgba(${r},${g},${b},${(0.22 + 0.78 * weight).toFixed(3)})` };
}

function title(c: GridCell): string {
  if (!c.games) return `${c.day} · no games`;
  const record = `${c.wins}W ${c.losses}L`;
  const d = c.delta >= 0 ? `+${c.delta}` : `${c.delta}`;
  return `${c.day} · ${c.games} game${c.games === 1 ? "" : "s"} · ${record} · ${d}`;
}

export function ActivityHeatmap({ grid, onDay }: { grid: ActivityGrid; onDay?: (c: GridCell) => void }) {
  const { columns, monthLabels, max, summary } = grid;
  const width = columns.length * (CELL + GAP) - GAP;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}>
      {/* The grid can be wider than a 320px phone, so it scrolls inside its own card
          rather than pushing the page sideways. */}
      <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", margin: "0 -2px", padding: "0 2px" }}>
        <div style={{ display: "flex", gap: 6, width: "max-content" }}>
          {/* weekday gutter — only alternate rows are labelled, same as GitHub */}
          <div style={{ display: "flex", flexDirection: "column", gap: GAP, paddingTop: 14, flexShrink: 0 }}>
            {["M", "", "W", "", "F", "", ""].map((d, i) => (
              <div key={i} style={{ height: CELL, fontSize: 8, lineHeight: `${CELL}px`, color: C.dimmer, width: 8, textAlign: "right" }}>{d}</div>
            ))}
          </div>
          <div>
            <div style={{ position: "relative", height: 14, width }}>
              {monthLabels.map((m) => (
                <span key={`${m.col}-${m.label}`} style={{ position: "absolute", left: m.col * (CELL + GAP), fontSize: 8.5, color: C.dimmer, fontWeight: 600 }}>{m.label}</span>
              ))}
            </div>
            <div style={{ display: "flex", gap: GAP }}>
              {columns.map((col, ci) => (
                <div key={ci} style={{ display: "flex", flexDirection: "column", gap: GAP }}>
                  {col.map((c) => {
                    const tappable = !!onDay && c.games > 0;
                    return (
                      <div
                        key={c.day}
                        title={title(c)}
                        onClick={tappable ? () => onDay(c) : undefined}
                        style={{
                          width: CELL, height: CELL, borderRadius: 2.5,
                          cursor: tappable ? "pointer" : "default",
                          ...cellStyle(c, max),
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, gap: 10, flexWrap: "wrap", rowGap: 6 }}>
        <span style={{ fontSize: 10.5, color: C.dimmer, fontFamily: "var(--font-mono)" }}>
          {summary.games} games · {summary.sessions} session{summary.sessions === 1 ? "" : "s"}
          {summary.longestGapDays > 0 && ` · longest gap ${summary.longestGapDays}d`}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9.5, color: C.dimmer }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "rgba(255,107,107,.8)" }} />
          lost
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "rgba(255,255,255,.045)", marginLeft: 4 }} />
          off
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "rgba(92,211,125,.8)", marginLeft: 4 }} />
          won
        </span>
      </div>
    </motion.div>
  );
}
