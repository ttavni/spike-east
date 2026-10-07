"use client";

// "What if Will & Tim beat Ben & Sam 21–15 tonight?" Pick any four people, tap the winners,
// slide the losing score — and see the exact deltas and rank moves, computed by the same
// engine that runs the real ladder. Nothing here is an approximation, and nothing is logged.
//
// Same gesture as the Log screen on purpose: tap the winner, then slide.

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  previewMatch,
  type LeagueMatch,
  type LeaguePlayer,
  type PlayerStat,
  type Standings,
} from "@/lib/league";
import { Avatar, C, ChipRow, ScoreRail, SPRING, WinChanceBar, press } from "@/components/spike/ui";

type Side = "A" | "B";
type Slots = { A: (string | null)[]; B: (string | null)[] };

const EMPTY: Slots = { A: [null, null], B: [null, null] };

/** The four slots in fill order, so tapping a chip always lands somewhere sensible. */
function place(slots: Slots, id: string): Slots {
  const next = { A: [...slots.A], B: [...slots.B] };
  for (const side of ["A", "B"] as const) {
    const i = next[side].indexOf(null);
    if (i >= 0) { next[side][i] = id; return next; }
  }
  return next; // all four taken — the chip is disabled in that case anyway
}

function remove(slots: Slots, id: string): Slots {
  return {
    A: slots.A.map((x) => (x === id ? null : x)),
    B: slots.B.map((x) => (x === id ? null : x)),
  };
}

function TeamCard({ label, ids, resolve, won, onPick, onClear }: {
  label: string; ids: (string | null)[]; resolve: (id: string) => PlayerStat | undefined;
  won: boolean; onPick: () => void; onClear: (id: string) => void;
}) {
  return (
    <motion.div
      animate={{ borderColor: won ? "rgba(203,251,79,.45)" : "rgba(255,255,255,.08)" }}
      transition={SPRING}
      style={{ flex: 1, minWidth: 0, background: won ? "rgba(203,251,79,.06)" : C.surface, border: "1px solid", borderRadius: 14, padding: 10 }}
    >
      <button
        onClick={onPick}
        className={press}
        style={{ width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 10, fontWeight: 800, letterSpacing: ".06em", color: won ? C.accent : C.dim, textAlign: "center", marginBottom: 8 }}
      >
        {won ? "WINNERS" : `${label} — TAP TO WIN`}
      </button>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {ids.map((id, i) => {
          const p = id ? resolve(id) : undefined;
          return (
            <button
              key={i}
              onClick={id ? () => onClear(id) : onPick}
              className={press}
              style={{ display: "flex", alignItems: "center", gap: 7, height: 36, borderRadius: 10, border: `1px ${id ? "solid" : "dashed"} rgba(255,255,255,.12)`, background: id ? C.raised : "none", padding: "0 9px", cursor: "pointer", width: "100%", textAlign: "left" }}
            >
              {p
                ? <><Avatar name={p.name} color={p.color} size={22} /><span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span></>
                : <span style={{ fontSize: 11.5, color: "#4A5056" }}>Empty slot</span>}
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}

export function WhatIf({
  players, matches, cs, me, to = 21, onOpenPlayer,
}: {
  players: LeaguePlayer[];
  matches: LeagueMatch[];
  cs: Standings;
  /** Signed-in player, if any — they get the first slot, since it's usually their game. */
  me?: string | null;
  /** What the game is played to: the season's rule. Sets the winning score and the odds. */
  to?: number;
  onOpenPlayer?: (id: string) => void;
}) {
  const [slots, setSlots] = useState<Slots>(() => (me && cs.st[me] ? place(EMPTY, me) : EMPTY));
  const [winner, setWinner] = useState<Side>("A");
  const [loserScore, setLoserScore] = useState(15);

  const pool = useMemo(() => [...cs.played, ...cs.unranked].filter((p) => p.active), [cs]);
  const picked = [...slots.A, ...slots.B].filter((x): x is string => x !== null);
  const full = picked.length === 4;
  const winScore = Math.max(to, loserScore + 2);
  const scoreA = winner === "A" ? winScore : loserScore;
  const scoreB = winner === "B" ? winScore : loserScore;

  const preview = useMemo(() => {
    if (!full) return null;
    return previewMatch(players, matches, cs, {
      teamA: slots.A as string[], teamB: slots.B as string[], scoreA, scoreB, to,
    });
  }, [full, players, matches, cs, slots, scoreA, scoreB, to]);

  const toggle = (id: string) => setSlots((s) => (picked.includes(id) ? remove(s, id) : full ? s : place(s, id)));
  const nameOf = (side: Side) => slots[side].map((id) => (id ? cs.st[id]?.name ?? "?" : "?")).join(" & ");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <TeamCard label="TEAM 1" ids={slots.A} resolve={(id) => cs.st[id]} won={winner === "A"} onPick={() => setWinner("A")} onClear={(id) => setSlots((s) => remove(s, id))} />
        <TeamCard label="TEAM 2" ids={slots.B} resolve={(id) => cs.st[id]} won={winner === "B"} onPick={() => setWinner("B")} onClear={(id) => setSlots((s) => remove(s, id))} />
      </div>

      <ChipRow focus={picked[picked.length - 1] ?? null}>
        {pool.map((p) => {
          const on = picked.includes(p.id);
          const disabled = !on && full;
          return (
            <button
              key={p.id}
              onClick={disabled ? undefined : () => toggle(p.id)}
              className={press}
              data-chip={p.id}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "4px 10px 4px 4px", borderRadius: 999,
                cursor: disabled ? "default" : "pointer", flexShrink: 0,
                background: on ? "rgba(203,251,79,.12)" : C.surface,
                border: `1px solid ${on ? "rgba(203,251,79,.4)" : "rgba(255,255,255,.07)"}`,
                opacity: disabled ? 0.3 : 1,
              }}
            >
              <Avatar name={p.name} color={p.color} size={20} />
              <span style={{ fontSize: 12, fontWeight: 600, color: on ? C.accent : C.fg, whiteSpace: "nowrap" }}>{p.name}</span>
            </button>
          );
        })}
      </ChipRow>

      {/* The winner tracks loser+2, exactly like the Log form — so the rail can't reach a
          scoreline that would be rejected if it were ever actually played. */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 26, fontWeight: 800, color: winner === "A" ? C.accent : C.fg }}>{scoreA}</span>
          <span style={{ fontSize: 15, color: C.dim }}>–</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 26, fontWeight: 800, color: winner === "B" ? C.accent : C.fg }}>{scoreB}</span>
        </div>
        <ScoreRail value={loserScore} onChange={setLoserScore} tint={C.fg} />
        <div style={{ fontSize: 10, color: C.dimmer, textAlign: "center" }}>losing score</div>
      </div>

      {!full ? (
        <div style={{ textAlign: "center", fontSize: 12.5, color: C.dim, padding: "10px 0" }}>
          Pick four players.
        </div>
      ) : preview && preview.rows.length ? (
        <>
          <div style={{ background: C.panel, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: "13px 14px" }}>
            <WinChanceBar probA={preview.winProb} aWon={winner === "A"} nameA={nameOf("A")} nameB={nameOf("B")} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {preview.rows.map((r) => {
              const p = cs.st[r.id];
              const moved = r.rankBefore && r.rankAfter ? r.rankBefore - r.rankAfter : 0;
              return (
                <button
                  key={r.id}
                  onClick={onOpenPlayer ? () => onOpenPlayer(r.id) : undefined}
                  className={press}
                  style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 11, padding: "8px 11px", cursor: onOpenPlayer ? "pointer" : "default", textAlign: "left" }}
                >
                  <Avatar name={p.name} color={p.color} size={22} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                    <span style={{ display: "block", fontSize: 10, color: moved !== 0 ? C.accent : C.dimmer, marginTop: 1 }}>
                      {moved > 0 ? `up to #${r.rankAfter}` : moved < 0 ? `down to #${r.rankAfter}` : r.rankAfter && !r.rankBefore ? `in at #${r.rankAfter}` : r.rankAfter ? `stays #${r.rankAfter}` : "still placing"}
                    </span>
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: C.dimmer }}>{r.ratingBefore} →</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 800, color: C.fg }}>{r.ratingAfter}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800, minWidth: 32, textAlign: "right", color: r.delta > 0 ? C.win : r.delta < 0 ? C.loss : C.dim }}>
                    {r.delta > 0 ? "+" : ""}{r.delta}
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 10.5, color: C.dimmer, lineHeight: 1.4 }}>
            Hypothetical — nothing is logged. Run through the same engine as the real ladder.
          </div>
        </>
      ) : null}
    </div>
  );
}
