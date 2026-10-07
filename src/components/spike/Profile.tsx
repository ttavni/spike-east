"use client";

// The player profile. Minimal by default: a hero rating card and a stack of collapsed rows,
// each showing a teaser so the page still says something at a glance. Everything else is one
// tap away. The point is a rabbit hole you choose to go down, not a wall of numbers.

import { useMemo } from "react";
import { motion } from "motion/react";
import {
  activityGrid,
  computeBadges,
  streakInfo,
  PROV_N,
  START,
  UPSET_PROB,
  type GridCell,
  type PlayerStat,
} from "@/lib/league";
import { RatingChart } from "@/components/RatingChart";
import { ActivityHeatmap } from "@/components/spike/ActivityHeatmap";
import { GameHistory } from "@/components/spike/GameHistory";
import {
  Avatar, C, Disclosure, RelCard, TierChip, rankLine, press,
} from "@/components/spike/ui";

export function ProfileHeader({ p, final = false }: { p: PlayerStat; final?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
      <Avatar name={p.name} color={p.color} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em" }}>{p.name}</div>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, rowGap: 6, marginTop: 4 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: C.accent, fontFamily: "var(--font-mono)" }}>{rankLine(p, final)}</span>
          {p.games > 0 && <TierChip rating={p.rating} provisional={p.provisional} size="md" />}
        </div>
      </div>
    </div>
  );
}

/** Highest win rate over at least two games together, ties broken by volume. */
function bestPartner(p: PlayerStat) {
  let best: { id: string; wr: number; games: number; wins: number } | null = null;
  for (const [id, x] of Object.entries(p.partners)) {
    if (x.games < 2) continue;
    const wr = x.wins / x.games;
    if (!best || wr > best.wr || (wr === best.wr && x.games > best.games)) best = { id, wr, games: x.games, wins: x.wins };
  }
  return best;
}

/** The opponent they've done worst against, over at least two meetings. */
function nemesis(p: PlayerStat) {
  let worst: { id: string; wr: number; wins: number; losses: number } | null = null;
  for (const [id, x] of Object.entries(p.opps)) {
    if (x.games < 2) continue;
    const wr = x.wins / x.games;
    if (!worst || wr < worst.wr) worst = { id, wr, wins: x.wins, losses: x.losses };
  }
  return worst;
}

function Dots({ form }: { form: ("W" | "L")[] }) {
  return (
    <span style={{ display: "flex", gap: 4 }}>
      {form.map((r, i) => (
        <span key={i} style={{ width: 7, height: 7, borderRadius: 99, background: r === "W" ? C.win : C.loss }} />
      ))}
    </span>
  );
}

/** A tight label/value pair — the profile's unit of information now that tiles are gone. */
function Line({ label, value, color = C.fg }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
      <span style={{ fontSize: 12.5, color: C.muted }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 700, color, flexShrink: 0 }}>{value}</span>
    </div>
  );
}

export function ProfileScreen({
  p, resolve, isOwn, now, onOpenPlayer, onOpenH2H, onOpenMatch, onOpenDay, onExplain, onSignOut, period, final,
}: {
  p: PlayerStat;
  resolve: (id: string) => PlayerStat;
  isOwn: boolean;
  /** Passed in rather than read here, so the grid can't differ between server and client. */
  now: number;
  onOpenPlayer: (id: string) => void;
  onOpenH2H: (otherId: string) => void;
  onOpenMatch: (matchId: string) => void;
  onOpenDay: (cell: GridCell) => void;
  onExplain: () => void;
  onSignOut: () => void;
  /** The view on screen, as it reads in a sentence: "this season", "in Season 1", "all-time". */
  period: string;
  /** A finished season's final table. */
  final: boolean;
}) {
  const si = streakInfo(p.streak);
  const badges = useMemo(() => computeBadges(p, period === "all-time" ? null : { period, final }), [p, period, final]);
  const grid = useMemo(() => activityGrid(p, { weeks: 26, now }), [p, now]);

  if (p.games === 0) {
    return (
      <div style={{ padding: "14px 16px 0" }}>
        <ProfileHeader p={p} final={final} />
        <div style={{ textAlign: "center", padding: "50px 20px", color: C.dim }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.num }}>{period === "all-time" ? "No matches yet" : `No games ${period}`}</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {period.startsWith("in ") ? `${p.name} didn't play ${period}.` : `${p.name} gets a rank after ${PROV_N} games${period === "this season" ? " this season" : ""}.`}
          </div>
          {isOwn && <button onClick={onSignOut} className={press} style={{ marginTop: 24, height: 46, padding: "0 22px", borderRadius: 13, background: "none", border: "1px solid rgba(255,107,107,.3)", color: C.loss, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Sign out</button>}
        </div>
      </div>
    );
  }

  // Against where they started, not a fixed number: late joiners don't start on START.
  const net = p.rating - (p.hist[0]?.r ?? START);
  const season = period !== "all-time";
  // const, not let: TypeScript only narrows a const inside the onClick closures below.
  const bp = bestPartner(p);
  const nm = nemesis(p);

  const upsets = p.matches.filter((m) => m.won && m.winProb < UPSET_PROB).length;
  const biggestWin = p.matches.filter((m) => m.won).reduce((best, m) => Math.max(best, m.gf - m.ga), 0);

  return (
    <div style={{ padding: "14px 16px 0" }}>
      <ProfileHeader p={p} final={final} />

      {/* HERO — the one number that matters, and the way in to why it's that number. */}
      <motion.button
        onClick={onExplain}
        whileTap={{ scale: 0.985 }}
        style={{ width: "100%", textAlign: "left", background: "rgba(203,251,79,.05)", border: "1px solid rgba(203,251,79,.22)", borderRadius: 18, padding: "16px 16px 14px", cursor: "pointer", marginBottom: 10 }}
      >
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 44, fontWeight: 800, color: C.accent, lineHeight: 1 }}>{p.rating}</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.dimmer, letterSpacing: ".08em", marginTop: 5 }}>
              {season ? `RATING ${period.toUpperCase()}` : "RATING"}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800, color: p.momentum > 0 ? C.win : p.momentum < 0 ? C.loss : C.dim }}>
              {p.momentum >= 0 ? "+" : ""}{p.momentum}
            </div>
            <div style={{ fontSize: 10, color: C.dimmer, marginTop: 2 }}>last 5</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.07)" }}>
          <Dots form={p.last5} />
          <span style={{ fontSize: 12.5, color: C.muted, fontFamily: "var(--font-mono)" }}>{p.wins}–{p.losses}</span>
          {si.has && <span style={{ fontSize: 12, fontWeight: 800, color: si.color, fontFamily: "var(--font-mono)" }}>{si.label}</span>}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>Why {p.rating}? →</span>
        </div>
      </motion.button>

      {/* Everything else is opt-in. Teasers keep the page informative while it's closed. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Disclosure title="Rating over time" teaser={`${net >= 0 ? "+" : ""}${net} ${period}`}>
          <RatingChart data={p.hist} color={p.color} />
        </Disclosure>

        <Disclosure title="Activity" teaser={`${grid.summary.sessions} session${grid.summary.sessions === 1 ? "" : "s"}`}>
          <ActivityHeatmap grid={grid} onDay={onOpenDay} />
        </Disclosure>

        <Disclosure title="The numbers" teaser={`${p.winPct}% win`}>
          <div>
            <Line label="Win rate" value={`${p.winPct}%`} />
            <Line label="Points for / against" value={`${p.pf} / ${p.pa}`} />
            <Line label="Point difference" value={`${p.diff >= 0 ? "+" : ""}${p.diff}`} color={p.diff > 0 ? C.win : p.diff < 0 ? C.loss : C.fg} />
            <Line label="Average game" value={`${(p.pf / p.games).toFixed(1)}–${(p.pa / p.games).toFixed(1)}`} />
            <Line label={season ? "Season high" : "Peak rating"} value={p.peak} color={p.rating === p.peak ? C.accent : C.fg} />
            <Line label="Best unbeaten run" value={p.bestStreak} color={C.gold} />
            <Line label="Biggest win" value={biggestWin > 0 ? `+${biggestWin}` : "–"} color={C.win} />
            <Line label="Upsets won" value={upsets} color={upsets > 0 ? C.gold : C.fg} />
          </div>
        </Disclosure>

        {(bp || nm) && (
          <Disclosure title="Partners & rivals" teaser={bp ? resolve(bp.id).name : nm ? resolve(nm.id).name : ""}>
            <div style={{ display: "grid", gridTemplateColumns: bp && nm ? "1fr 1fr" : "1fr", gap: 9 }}>
              {bp && <RelCard kind="BEST PARTNER" color={C.win} id={bp.id} A={resolve} sub={`${bp.wins}–${bp.games - bp.wins} · ${Math.round(bp.wr * 100)}% win`} onClick={() => onOpenH2H(bp.id)} />}
              {nm && <RelCard kind="NEMESIS" color={C.loss} id={nm.id} A={resolve} sub={`${nm.wins}–${nm.losses} vs them`} onClick={() => onOpenH2H(nm.id)} />}
            </div>
            <div style={{ fontSize: 10.5, color: C.dimmer, marginTop: 8 }}>Tap either for the full head-to-head.</div>
          </Disclosure>
        )}

        {badges.length > 0 && (
          <Disclosure title="Badges" teaser={`${badges.length}`}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {badges.map((b) => (
                <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 8, background: C.panel, border: "1px solid rgba(203,251,79,.2)", borderRadius: 12, padding: "9px 12px" }}>
                  <span style={{ fontSize: 18 }}>{b.icon}</span>
                  <div><div style={{ fontSize: 12.5, fontWeight: 700 }}>{b.label}</div><div style={{ fontSize: 10.5, color: C.dim }}>{b.desc}</div></div>
                </div>
              ))}
            </div>
          </Disclosure>
        )}

        <Disclosure title="All games" teaser={`${p.games}`}>
          <GameHistory entries={p.matches} resolve={resolve} onOpenMatch={onOpenMatch} onOpenPlayer={onOpenPlayer} />
        </Disclosure>
      </div>

      {isOwn && <button onClick={onSignOut} className={press} style={{ width: "100%", marginTop: 18, height: 48, borderRadius: 14, background: "none", border: "1px solid rgba(255,107,107,.3)", color: C.loss, fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>Sign out</button>}
    </div>
  );
}
