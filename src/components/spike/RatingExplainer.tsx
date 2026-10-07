"use client";

// Why a rating is what it is, shown rather than explained: a ledger of real games with the
// par scoreline and the actual one next to the points they earned — no prose required.
//
// There is a third lever (how many games the league already has on you) and it deliberately
// has no column here: a fourth column doesn't fit a 360px phone. It lives in the match sheet
// instead, where tapping any player's ± opens the full `WhyDelta` breakdown — and every row
// here links straight there, so the ledger is the index and the sheet is the answer. The
// plain-English guide to the whole system is the ⓘ on the ladder, not this component.

import { useEffect, useMemo, useRef, useState } from "react";
import { parScoreline, ratingStory, type MatchEntry, type PlayerStat, type Standings } from "@/lib/league";
import { Avatar, C, press } from "@/components/spike/ui";

/** Rows per page. One page is more than a phone screen, so the fetch is always ahead of the eye. */
const PAGE = 15;

/**
 * Reveal `PAGE` more rows whenever the end of the list comes into view.
 *
 * The observer runs with `root: null` on purpose. The ledger lives inside the explainer
 * sheet's own `overflow-y: auto` column, and an ancestor with overflow CLIPS its children out
 * of the viewport intersection — so "visible to the viewport" already means "scrolled to
 * inside the sheet", and there's nothing to thread a scroll-container ref through for.
 */
function usePaged<T>(items: T[], resetKey: string) {
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement | null>(null);
  // A different player is a different list — start them at the top, not 40 rows down.
  useEffect(() => setShown(PAGE), [resetKey]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= items.length) return;
    const io = new IntersectionObserver(
      (es) => { if (es.some((e) => e.isIntersecting)) setShown((n) => Math.min(n + PAGE, items.length)); },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, items.length]);
  return { visible: items.slice(0, shown), shown, sentinel, more: Math.max(0, items.length - shown) };
}

const COLS = "1fr 46px 44px 44px";

function LedgerHead() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 6, padding: "0 12px 7px", fontSize: 9, fontWeight: 700, color: C.dimmer, letterSpacing: ".05em" }}>
      <span>GAME</span>
      <span style={{ textAlign: "center" }}>PAR</span>
      <span style={{ textAlign: "center" }}>SCORE</span>
      <span style={{ textAlign: "right" }}>POINTS</span>
    </div>
  );
}

function LedgerRow({
  e, resolve, onOpenMatch, highlight,
}: { e: MatchEntry; resolve: (id: string) => PlayerStat; onOpenMatch?: (id: string) => void; highlight?: boolean }) {
  // Par is the scoreline the league expected from this team going in. Below 40% of the
  // points means the odds were against you — a win from there is worth more, so it's gold.
  const par = parScoreline(e.expShare, e.to);
  const dc = e.delta > 0 ? C.win : e.delta < 0 ? C.loss : C.dim;
  return (
    <button
      onClick={onOpenMatch ? () => onOpenMatch(e.id) : undefined}
      className={press}
      style={{ display: "grid", gridTemplateColumns: COLS, gap: 6, alignItems: "center", width: "100%", padding: "9px 12px", background: highlight ? "rgba(203,251,79,.05)" : "none", border: "none", borderTop: "1px solid rgba(255,255,255,.045)", cursor: onOpenMatch ? "pointer" : "default", textAlign: "left" }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <span style={{ display: "flex", flexShrink: 0 }}>
          {e.opps.map((o, i) => (
            <span key={o} style={{ marginLeft: i ? -7 : 0 }}>
              <Avatar name={resolve(o)?.name ?? "?"} color={resolve(o)?.color ?? "#888"} size={19} ring={C.surface} />
            </span>
          ))}
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: C.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            v {e.opps.map((o) => resolve(o)?.name ?? "?").join(" & ")}
          </span>
          <span style={{ display: "block", fontSize: 9.5, color: C.dimmer, marginTop: 1 }}>{e.date}</span>
        </span>
      </span>
      {/* What the league expected — half the story. */}
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, textAlign: "center", color: e.expShare < 0.4 ? C.gold : C.num }}>{par}</span>
      {/* And what actually happened — the other half. Beat par and the points follow. */}
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, textAlign: "center", color: e.won ? C.fg : C.num }}>{e.gf}–{e.ga}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 800, textAlign: "right", color: dc }}>{e.delta > 0 ? "+" : ""}{e.delta}</span>
    </button>
  );
}

export function RatingExplainer({
  p, cs, resolve, onOpenMatch,
}: {
  p?: PlayerStat;
  cs?: Standings;
  resolve?: (id: string) => PlayerStat;
  onOpenMatch?: (matchId: string) => void;
}) {
  // Personal view: this player's own ledger. Its own component so the paging hooks below
  // aren't sitting behind a conditional return.
  if (p && p.games > 0 && resolve) {
    return <PersonalLedger p={p} resolve={resolve} onOpenMatch={onOpenMatch} />;
  }

  // League view: the games that moved anyone the most, so the levers are obvious at scale.
  if (cs && resolve) {
    const all: { e: MatchEntry; id: string }[] = [];
    for (const q of cs.all) for (const e of q.matches) all.push({ e, id: q.id });
    const top = all.sort((a, b) => Math.abs(b.e.delta) - Math.abs(a.e.delta)).slice(0, 15);
    if (top.length === 0) {
      return <div style={{ textAlign: "center", padding: "60px 20px", color: C.dim, fontSize: 13.5 }}>No games logged yet.</div>;
    }
    return (
      <div>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
          Every game has a <b style={{ color: C.gold }}>par</b> scoreline — what the league expected — and
          you move by how far the <b style={{ color: C.fg }}>real one</b> beat it or fell short. Tap a game
          for the full breakdown; the plain-English guide is behind the ⓘ on the ladder. The biggest
          swings so far:
        </div>
        <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, paddingTop: 11, overflow: "hidden" }}>
          <LedgerHead />
          {top.map(({ e, id }) => (
            <div key={`${id}-${e.idx}`}>
              <div style={{ padding: "8px 12px 0", fontSize: 10, fontWeight: 700, color: C.dimmer }}>{resolve(id)?.name ?? "?"}</div>
              <LedgerRow e={e} resolve={resolve} onOpenMatch={onOpenMatch} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

function PersonalLedger({
  p, resolve, onOpenMatch,
}: {
  p: PlayerStat;
  resolve: (id: string) => PlayerStat;
  onOpenMatch?: (matchId: string) => void;
}) {
  const story = ratingStory(p);
  const parts = story.parts;
  // Newest game first. `t` is the match epoch, and several games share one evening, so `idx`
  // (position in the league's chronological replay) breaks those ties in the true order —
  // sorting on the timestamp alone leaves a night's games in an arbitrary sequence.
  const chrono = useMemo(
    () => [...p.matches].sort((a, b) => b.t - a.t || b.idx - a.idx),
    [p.matches],
  );
  // Still worth pointing at the single game that moved them most, wherever it now sits.
  const biggest = useMemo(
    () => p.matches.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a), p.matches[0]),
    [p.matches],
  );
  const { visible, sentinel, more } = usePaged(chrono, p.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* start + won − lost ± revalued = rating, exactly. The parts come straight off the
          ledger, so anyone can check the sum against the rows below. */}
      <div style={{ background: C.panel, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, padding: "16px 14px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 7, flexWrap: "wrap", rowGap: 4 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: C.num }}>{parts.start}</span>
          <span style={{ fontSize: 15, color: C.dim }}>+</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: C.win }}>{parts.fromWins}</span>
          <span style={{ fontSize: 15, color: C.dim }}>−</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: C.loss }}>{Math.abs(parts.fromLosses)}</span>
          <span style={{ fontSize: 15, color: C.dim }}>{parts.revalued < 0 ? "−" : "+"}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: C.muted }}>{Math.abs(parts.revalued)}</span>
          <span style={{ fontSize: 15, color: C.dim }}>=</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 800, color: C.accent }}>{p.rating}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 6, fontSize: 9.5, color: C.dimmer, letterSpacing: ".04em", textTransform: "uppercase", fontWeight: 700 }}>
          <span>start</span><span>·</span><span>won</span><span>·</span><span>lost</span><span>·</span><span>revalued</span><span>·</span><span>rating</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Fact label="wins won you" value={`+${story.climbFromWins}`} color={C.win} sub={`${p.wins} game${p.wins === 1 ? "" : "s"}`} />
        <Fact label="losses cost you" value={`${story.dropFromLosses}`} color={C.loss} sub={`${p.losses} game${p.losses === 1 ? "" : "s"}`} />
        {/* Placing players get told how far off a rank they are; placed players get the one
            number the hero shows but nobody expects — how much other people's games moved them. */}
        {story.gamesToPlace > 0
          ? <Fact label="to get a rank" value={`${story.gamesToPlace} more`} color={C.accent} sub={story.gamesToPlace === 1 ? "game" : "games"} />
          : <Fact label="revalued" value={`${parts.revalued > 0 ? "+" : ""}${parts.revalued}`} color={parts.revalued > 0 ? C.win : parts.revalued < 0 ? C.loss : C.dim} sub="by others' games" />}
      </div>

      <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, paddingTop: 11, overflow: "hidden" }}>
        <LedgerHead />
        {visible.map((e) => (
          <LedgerRow key={`${e.idx}-${e.id}`} e={e} resolve={resolve} onOpenMatch={onOpenMatch} highlight={e === biggest} />
        ))}
        {/* The sentinel carries the remaining count, so a long history says how much is
            left rather than just ending on a blank strip mid-scroll. */}
        {more > 0 && (
          <div ref={sentinel} style={{ padding: "12px 12px 14px", textAlign: "center", fontSize: 10.5, color: C.dimmer, borderTop: "1px solid rgba(255,255,255,.045)" }}>
            {more} earlier {more === 1 ? "game" : "games"}…
          </div>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value, color, sub }: { label: string; value: string; color: string; sub: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: C.panel, border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, padding: "10px 11px" }}>
      <div style={{ fontSize: 9, color: C.dimmer, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 800, color, marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 9.5, color: C.dimmer, marginTop: 1 }}>{sub}</div>
    </div>
  );
}
