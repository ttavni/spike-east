"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

type Point = { t: number; r: number };

function fmtDate(t: number) {
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function fmtMonth(t: number) {
  return new Date(t).toLocaleDateString("en-GB", { month: "short" });
}

export function RatingChart({ data, color = "#CBFB4F" }: { data: Point[]; color?: string }) {
  // Only real match points carry a timestamp (baseline t === 0).
  const points = data.filter((p) => p.t > 0);
  if (points.length < 2) {
    return <div style={{ height: 130, display: "flex", alignItems: "center", justifyContent: "center", color: "#6B7177", fontSize: 13 }}>Play a few games to see your trend.</div>;
  }
  const rs = points.map((p) => p.r);
  const lo = Math.min(...rs), hi = Math.max(...rs), pad = Math.max(8, (hi - lo) * 0.2);

  return (
    <div style={{ height: 150, marginLeft: -8, touchAction: "pan-y" }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="ratingFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={fmtMonth}
            tick={{ fill: "#6B7177", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis domain={[lo - pad, hi + pad]} hide />
          <Tooltip
            cursor={{ stroke: "rgba(255,255,255,.2)", strokeWidth: 1 }}
            contentStyle={{ background: "#1B1F23", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, fontSize: 12, padding: "6px 10px" }}
            labelStyle={{ color: "#8A9196", fontSize: 11, marginBottom: 2 }}
            itemStyle={{ color: "#F4F5F6", fontWeight: 700 }}
            labelFormatter={(t) => fmtDate(Number(t))}
            formatter={(v) => [String(v), "Rating"]}
          />
          <Area type="monotone" dataKey="r" stroke={color} strokeWidth={2.2} fill="url(#ratingFill)" dot={false} activeDot={{ r: 4, fill: color, stroke: "#0C0E10", strokeWidth: 2 }} animationDuration={350} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
