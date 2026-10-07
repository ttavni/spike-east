"use client";

// The league's own page: the hall of fame, the counting stats people argue about, the
// whole-league rating race, and the explainer. Everything names real people and links
// through — a record you can't tap is just trivia.

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  leaderboards,
  leagueRecords,
  type LeagueMatch,
  type LeaguePlayer,
  type PlayerStat,
  type Standings,
} from "@/lib/league";
import { HeadToHead } from "@/components/spike/HeadToHead";
import { RaceChart } from "@/components/spike/RaceChart";
import { RatingExplainer } from "@/components/spike/RatingExplainer";
import { WhatIf } from "@/components/spike/WhatIf";
import { Avatar, C, SegTabs, listV, press, rowV } from "@/components/spike/ui";

type Tab = "records" | "leaders" | "race" | "how";

export function StatsScreen({
  cs, players, matches, me, final = false, to = 21, onOpenPlayer, onOpenMatch,
}: {
  cs: Standings;
  /** The raw roster — the what-if calculator replays the league, so it needs the inputs. */
  players: LeaguePlayer[];
  matches: LeagueMatch[];
  me?: string | null;
  /** A finished season: there's no "right now" to try a result against. */
  final?: boolean;
  /** What a game in this view is played to, for the what-if. */
  to?: number;
  onOpenPlayer: (id: string) => void;
  onOpenMatch: (matchId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("records");
  const { records, totals } = useMemo(() => leagueRecords(cs, matches), [cs, matches]);
  const boards = useMemo(() => leaderboards(cs), [cs]);
  const A = (id: string): PlayerStat => cs.st[id];

  // The two the league would most like compared, as a starting point: you and the person
  // above you if you're signed in, otherwise the top of the ladder. Re-read from the view on
  // screen until someone picks, so switching season never leaves it stuck on an empty pair.
  const suggested = useMemo(() => {
    const top = cs.ranked;
    if (me && cs.st[me]?.games) {
      const i = top.findIndex((p) => p.id === me);
      const other = i > 0 ? top[i - 1] : top[i + 1];
      return { a: me, b: other?.id ?? null };
    }
    return { a: top[0]?.id ?? null, b: top[1]?.id ?? null };
  }, [cs, me]);
  const [picked, setPicked] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  // Never the same player on both sides: a suggestion gives way to whoever was picked.
  const a = picked.a ?? (suggested.a !== picked.b ? suggested.a : suggested.b);
  const b = picked.b ?? (suggested.b !== a ? suggested.b : suggested.a !== a ? suggested.a : null);
  const pair = { a, b };

  return (
    <div style={{ padding: "14px 16px 0" }}>
      <SegTabs
        group="stats"
        value={tab}
        onChange={setTab}
        options={[["records", "Records"], ["leaders", "Leaders"], ["race", "Race"], ["how", "Scoring"]] as const}
      />

      {tab === "records" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <Total label="games" value={`${totals.games}`} />
            <Total label="players" value={`${totals.players}`} />
            <Total label="points" value={`${totals.points}`} />
          </div>
          {records.length === 0 ? (
            <Empty>Nothing to brag about yet — log a few games.</Empty>
          ) : (
            <motion.div variants={listV} initial="initial" animate="animate" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {records.map((r) => (
                <motion.button
                  key={r.key}
                  variants={rowV}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => (r.matchId ? onOpenMatch(r.matchId) : onOpenPlayer(r.playerIds[0]))}
                  style={{ display: "flex", alignItems: "center", gap: 12, background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: "12px 13px", cursor: "pointer", textAlign: "left", width: "100%" }}
                >
                  <span style={{ fontSize: 20, flexShrink: 0 }}>{r.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, letterSpacing: ".05em", textTransform: "uppercase" }}>{r.label}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, minWidth: 0 }}>
                      <span style={{ display: "flex", flexShrink: 0 }}>
                        {r.playerIds.slice(0, 4).map((id, i) => (
                          <span key={id} style={{ marginLeft: i ? -8 : 0 }}>
                            <Avatar name={A(id)?.name ?? "?"} color={A(id)?.color ?? "#888"} size={22} ring={C.surface} />
                          </span>
                        ))}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {r.playerIds.slice(0, 2).map((id) => A(id)?.name ?? "?").join(" & ")}
                        {r.playerIds.length > 2 && ` +${r.playerIds.length - 2}`}
                      </span>
                    </div>
                    <div style={{ fontSize: 10.5, color: C.dimmer, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.detail}</div>
                  </div>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 800, color: C.accent, flexShrink: 0 }}>{r.value}</span>
                </motion.button>
              ))}
            </motion.div>
          )}
        </>
      )}

      {tab === "leaders" && (
        boards.length === 0 ? <Empty>No games logged yet.</Empty> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {boards.map((b) => {
              const max = Math.max(1, ...b.rows.map((r) => r.value));
              return (
                <div key={b.id}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".05em", textTransform: "uppercase", marginBottom: 8, paddingLeft: 2 }}>{b.label}</div>
                  <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, overflow: "hidden" }}>
                    {b.rows.map((row, i) => (
                      <button
                        key={row.id}
                        onClick={() => onOpenPlayer(row.id)}
                        className={press}
                        style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", background: "none", border: "none", borderBottom: i < b.rows.length - 1 ? "1px solid rgba(255,255,255,.04)" : "none", cursor: "pointer", textAlign: "left" }}
                      >
                        {/* A bar behind the row, so the gaps between people are visible at a
                            glance. Subtle, but it has to actually read — much below this and
                            it may as well not be there. */}
                        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(row.value / max) * 100}%`, background: i === 0 ? "rgba(203,251,79,.10)" : "rgba(255,255,255,.055)" }} />
                        <span style={{ position: "relative", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: i === 0 ? C.accent : C.dimmer, width: 12, flexShrink: 0 }}>{i + 1}</span>
                        <span style={{ position: "relative", flexShrink: 0 }}><Avatar name={A(row.id)?.name ?? "?"} color={A(row.id)?.color ?? "#888"} size={24} /></span>
                        <span style={{ position: "relative", flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{A(row.id)?.name ?? "?"}</span>
                          <span style={{ display: "block", fontSize: 10, color: C.dimmer, marginTop: 1 }}>{row.sub}</span>
                        </span>
                        <span style={{ position: "relative", fontFamily: "var(--font-mono)", fontSize: 14.5, fontWeight: 800, color: i === 0 ? C.accent : C.fg, flexShrink: 0 }}>
                          {row.value}{b.unit}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {tab === "race" && <RaceChart cs={cs} onOpenPlayer={onOpenPlayer} />}

      {/* Three sections, not three tabs. Two of them are the "explore a hypothetical" tools
          and the third is the reference for both, so they belong together — and four tabs
          fit a 360px phone at full size where five needed shrunken type. The tools are
          expanded and the ledger is the long tail underneath. */}
      {tab === "how" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div>
            <SectionHead title="What if…" sub="Try a result and see what it would do to the ladder." />
            {final ? (
              <div style={{ fontSize: 12.5, color: C.dim, background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: "13px 14px" }}>
                This season&apos;s finished. Switch to the season in progress to try a result.
              </div>
            ) : (
              <WhatIf players={players} matches={matches} cs={cs} me={me} to={to} onOpenPlayer={onOpenPlayer} />
            )}
          </div>
          <div>
            <SectionHead title="Head to head" sub="Pick any two and see how they compare." />
            {cs.count === 0 ? <Empty>No games logged yet.</Empty> : (
              <HeadToHead
                cs={cs}
                a={pair.a}
                b={pair.b}
                onPick={(side, id) => setPicked((cur) => ({ ...cur, [side]: id }))}
                onOpenPlayer={onOpenPlayer}
                onOpenMatch={onOpenMatch}
              />
            )}
          </div>
          <div>
            <SectionHead title="What moves a rating" />
            <RatingExplainer cs={cs} resolve={A} onOpenMatch={onOpenMatch} />
          </div>
        </div>
      )}
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: 1, background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, padding: "10px 12px" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: C.fg }}>{value}</div>
      <div style={{ fontSize: 9.5, color: C.dimmer, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", marginTop: 1 }}>{label}</div>
    </div>
  );
}

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase" }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: C.dimmer, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ textAlign: "center", padding: "60px 20px", color: C.dim, fontSize: 13.5 }}>{children}</div>;
}
