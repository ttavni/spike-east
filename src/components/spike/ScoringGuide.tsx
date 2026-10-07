"use client";

// The one place the app explains how the number works, in plain English. Opened from the ⓘ
// next to the ladder's subtitle, guests included. Four short sections: the number, what a
// game is worth (shown on the league's most recent real game, not a made-up one), getting
// placed, and the tiers. No maths — the maths lives in the engine and the per-game ledger
// (`RatingExplainer`) shows it; this is the manifesto that makes both make sense.
//
// Props in, pixels out. The caller wraps it in the same sheet chrome as the other sheets.

import { useMemo } from "react";
import {
  explainDelta,
  PROV_N,
  PROVISIONAL_TIER,
  START,
  TIERS,
  tierOf,
  WIN_MIN,
  type MatchEntry,
  type PlayerStat,
  type Standings,
} from "@/lib/league";
import { Avatar, C } from "./ui";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 7 }}>{title}</div>
      {children}
    </div>
  );
}

const body: React.CSSProperties = { fontSize: 13, color: C.muted, lineHeight: 1.55 };
const em: React.CSSProperties = { color: C.fg, fontWeight: 600 };

/** The four player-views of the league's most recent game, winners first. */
function lastGame(cs: Standings): { rows: { p: PlayerStat; e: MatchEntry }[]; date: string } | null {
  let latest: MatchEntry | null = null;
  for (const p of cs.played) for (const e of p.matches) {
    if (!latest || e.t > latest.t || (e.t === latest.t && e.idx > latest.idx)) latest = e;
  }
  if (!latest) return null;
  const id = latest.id;
  const rows: { p: PlayerStat; e: MatchEntry }[] = [];
  for (const p of cs.played) {
    const e = p.matches.find((x) => x.id === id);
    if (e) rows.push({ p, e });
  }
  rows.sort((a, b) => Number(b.e.won) - Number(a.e.won));
  return { rows, date: latest.date };
}

export function ScoringGuide({ cs, meId, season }: {
  /** The view on screen: its last game, and the tiers' "YOU". */
  cs: Standings;
  meId: string | null;
  /** The season in progress, once there's more than one; null while the league is still in its first. */
  season: number | null;
}) {
  const last = useMemo(() => lastGame(cs), [cs]);
  // Only a placed player has a tier worth pointing at — "Fresh Meat" isn't on this list.
  const myStat = meId ? cs.st[meId] : undefined;
  const myTier = myStat && myStat.games >= PROV_N ? tierOf(myStat.rating, false).name : null;
  const topMin = TIERS[TIERS.length - 1].min;
  const anyoneAtTop = cs.ranked.some((p) => p.rating >= topMin);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Section title="The number">
        <div style={body}>
          Everyone starts on <span style={em}>{START}</span>. Every game is scored on the <span style={em}>points</span>, not just the win: beat the score the league expected and you go up; fall short and you go down. A win always pays, though: fall short of par in a win and you still get at least <span style={em}>+{WIN_MIN}</span>, more the bigger the margin. Recent games count more than old ones. The whole ladder is recomputed from all of its games after each result, so it doesn&apos;t matter who logs first or how often you play. Only how you play.
        </div>
      </Section>

      {season !== null && (
        <Section title="Seasons">
          <div style={body}>
            Each season is a fresh start: everyone begins Season {season} on <span style={em}>{START}</span> with {PROV_N} games to place, and only that season&apos;s games count, for your rating and your tier alike. <span style={em}>All time</span> never resets: it keeps every game ever played, and it&apos;s what the matchmaker uses to make even teams. Switch between them at the top of the screen.
          </div>
        </Section>
      )}

      {last && (
        <Section title="Last game, for example">
          <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 48px 48px 40px", gap: 6, padding: "9px 12px 6px", fontSize: 9, fontWeight: 700, color: C.dimmer, letterSpacing: ".05em" }}>
              <span>{last.date.toUpperCase()}</span>
              <span style={{ textAlign: "center" }}>PAR</span>
              <span style={{ textAlign: "center" }}>SCORE</span>
              <span style={{ textAlign: "right" }}>±</span>
            </div>
            {last.rows.map(({ p, e }) => {
              const b = explainDelta(e);
              const dc = e.delta > 0 ? C.win : e.delta < 0 ? C.loss : C.dim;
              return (
                <div key={p.id} style={{ display: "grid", gridTemplateColumns: "1fr 48px 48px 40px", gap: 6, alignItems: "center", padding: "8px 12px", borderTop: "1px solid rgba(255,255,255,.045)" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <Avatar name={p.name} color={p.color} size={20} />
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: e.won ? C.fg : C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, textAlign: "center", color: C.num }}>{b.par}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, textAlign: "center", color: C.num }}>{e.gf}–{e.ga}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800, textAlign: "right", color: dc }}>{e.delta > 0 ? "+" : ""}{e.delta}</span>
                </div>
              );
            })}
          </div>
          <div style={{ ...body, fontSize: 11.5, color: C.dimmer, marginTop: 7 }}>
            Par is the scoreline the league expected. Team-mates share a par and a score, so they share the credit too. Ratings don&apos;t decide who gets more: whoever the league is less sure about (usually the one with fewer games) moves further, win or lose.
          </div>
        </Section>
      )}

      <Section title="Getting placed">
        <div style={body}>
          Your first <span style={em}>{PROV_N} games</span> put a number on you but not a rank — you&apos;re {PROVISIONAL_TIER.icon} {PROVISIONAL_TIER.name} until then. After that you get a rank, and a &ldquo;likely 6th–11th&rdquo; range that narrows as you play.
        </div>
      </Section>

      <Section title="The tiers">
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {[...TIERS].reverse().map((t, i) => {
            const mine = t.name === myTier;
            const top = i === 0;
            return (
              <div
                key={t.name}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "8px 11px", borderRadius: 11,
                  background: mine ? "rgba(203,251,79,.06)" : C.surface,
                  border: `1px solid ${mine ? "rgba(203,251,79,.4)" : "rgba(255,255,255,.05)"}`,
                }}
              >
                <span style={{ fontSize: 16, width: 22, textAlign: "center", flexShrink: 0 }}>{t.icon}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: t.color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                {mine && <span style={{ fontSize: 9.5, fontWeight: 800, color: C.ink, background: C.accent, borderRadius: 4, padding: "1px 4px", flexShrink: 0 }}>YOU</span>}
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: C.dimmer, flexShrink: 0 }}>
                  {top ? `${t.min}+${anyoneAtTop ? "" : " · nobody yet"}` : `from ${t.min}`}
                </span>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
