"use client";

// The whole league on one chart: who overtook whom, and when. Every player's rating history
// is stepped onto a shared time axis so the lines are directly comparable — without that,
// each player's series only has points on the days they happened to play, and recharts
// draws them as if everyone moved at once.

import { useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { isDormant, START, type PlayerStat, type Standings } from "@/lib/league";
import { Avatar, C, press } from "@/components/spike/ui";

function fmtMonth(t: number) {
  return new Date(t).toLocaleDateString("en-GB", { month: "short" });
}
function fmtDate(t: number) {
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function RaceChart({ cs, onOpenPlayer }: { cs: Standings; onOpenPlayer: (id: string) => void }) {
  const [solo, setSolo] = useState<string | null>(null);

  // Everyone with a game, placing included — a race is about the lines, not the rank.
  const players = useMemo(() => cs.played.filter((p) => p.active && p.games > 0), [cs]);

  // One row per distinct timestamp; each player's value carried forward from their last
  // game, so a flat line means "didn't play", not "no data".
  const rows = useMemo(() => {
    const stamps = new Set<number>();
    for (const p of players) for (const h of p.hist) if (h.t > 0) stamps.add(h.t);
    const sorted = [...stamps].sort((a, b) => a - b);
    const cursor = new Map<string, number>();
    const idx = new Map<string, number>();
    for (const p of players) { cursor.set(p.id, p.hist[0]?.r ?? START); idx.set(p.id, 1); }
    return sorted.map((t) => {
      const row: Record<string, number> = { t };
      for (const p of players) {
        let i = idx.get(p.id)!;
        while (i < p.hist.length && p.hist[i].t <= t) { cursor.set(p.id, p.hist[i].r); i++; }
        idx.set(p.id, i);
        row[p.id] = cursor.get(p.id)!;
      }
      return row;
    });
  }, [players]);

  if (rows.length < 2) {
    return <div style={{ textAlign: "center", padding: "60px 20px", color: C.dim, fontSize: 13.5 }}>Not enough history to race yet.</div>;
  }

  const values = rows.flatMap((r) => players.map((p) => r[p.id]));
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max(20, (hi - lo) * 0.08);
  const dim = (p: PlayerStat) => solo !== null && solo !== p.id;

  return (
    <div>
      <div style={{ height: 260, marginLeft: -10, touchAction: "pan-y" }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
              tickFormatter={fmtMonth} tick={{ fill: C.dim, fontSize: 10 }}
              tickLine={false} axisLine={false} minTickGap={30}
            />
            <YAxis domain={[lo - pad, hi + pad]} tick={{ fill: C.dimmer, fontSize: 10 }} tickLine={false} axisLine={false} width={34} />
            <Tooltip
              cursor={{ stroke: "rgba(255,255,255,.2)", strokeWidth: 1 }}
              contentStyle={{ background: "#1B1F23", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, fontSize: 12, padding: "6px 10px" }}
              labelStyle={{ color: C.muted, fontSize: 11, marginBottom: 2 }}
              labelFormatter={(t) => fmtDate(Number(t))}
              formatter={(v, name) => [String(v), cs.st[String(name)]?.name ?? String(name)]}
            />
            {players.map((p) => (
              <Line
                key={p.id}
                dataKey={p.id}
                stroke={p.color}
                strokeWidth={solo === p.id ? 2.8 : 1.7}
                strokeOpacity={dim(p) ? 0.12 : isDormant(p, cs) && solo === null ? 0.4 : 1}
                dot={false}
                isAnimationActive={false}
                type="monotone"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
        {players.map((p) => {
          const on = solo === p.id;
          return (
            <button
              key={p.id}
              onClick={() => setSolo(on ? null : p.id)}
              onDoubleClick={() => onOpenPlayer(p.id)}
              className={press}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 9px 4px 4px", borderRadius: 999, cursor: "pointer", background: on ? "rgba(203,251,79,.1)" : C.surface, border: `1px solid ${on ? "rgba(203,251,79,.35)" : "rgba(255,255,255,.07)"}`, opacity: dim(p) ? 0.45 : 1 }}
            >
              <Avatar name={p.name} color={p.color} size={18} />
              <span style={{ fontSize: 11.5, fontWeight: 600, color: C.fg }}>{p.name}</span>
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 10.5, color: C.dimmer, marginTop: 8, lineHeight: 1.4 }}>
        Tap a name to pick them out. Resting players are faded.
      </div>
    </div>
  );
}
