"use client";

// Pick any two people and settle it. The rivalry scoreline, their careers side by side,
// and every game they've shared a court in — split into the ones they played against each
// other and the ones they played together, because those are two different records.
//
// Selection is controlled by the caller: the Stats tab keeps it in its own state, and the
// sheet opened from a profile's partner/nemesis cards seeds it from that card.

import { useMemo } from "react";
import {
  comparePlayers,
  headToHead,
  type MatchEntry,
  type PlayerStat,
  type Standings,
} from "@/lib/league";
import { Avatar, C, ChipRow, Disclosure, ResultRow, press } from "@/components/spike/ui";

/** A player's own entry for a game, back in the shape the shared result card renders. */
function asResult(p: PlayerStat, e: MatchEntry) {
  return { teamA: [p.id, e.partner], teamB: e.opps, scoreA: e.gf, scoreB: e.ga, date: e.date };
}

function Chip({ p, on, disabled, onClick }: { p: PlayerStat; on: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
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
}

function Picker({ label, pool, value, blocked, onPick }: {
  label: string; pool: PlayerStat[]; value: string | null; blocked: string | null; onPick: (id: string) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 7 }}>{label}</div>
      <ChipRow focus={value}>
        {pool.map((p) => (
          <Chip key={p.id} p={p} on={value === p.id} disabled={blocked === p.id} onClick={() => onPick(p.id)} />
        ))}
      </ChipRow>
    </div>
  );
}

function MiniFact({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: C.panel, border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, padding: "9px 10px" }}>
      <div style={{ fontSize: 9, color: C.dimmer, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 800, color, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      <div style={{ fontSize: 9.5, color: C.dimmer, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
    </div>
  );
}

export function HeadToHead({
  cs, a, b, onPick, showPickers = true, onOpenPlayer, onOpenMatch,
}: {
  cs: Standings;
  a: string | null;
  b: string | null;
  onPick: (side: "a" | "b", id: string) => void;
  /** The sheet opened from a profile already knows both people; the Stats tab doesn't. */
  showPickers?: boolean;
  onOpenPlayer?: (id: string) => void;
  onOpenMatch?: (matchId: string) => void;
}) {
  const pa = a ? cs.st[a] : undefined;
  const pb = b ? cs.st[b] : undefined;
  // Everyone who could be picked — inactive players stay out of the picker but still
  // resolve above, so a rivalry with someone since removed still renders from a profile.
  const pool = useMemo(() => [...cs.played, ...cs.unranked].filter((p) => p.active), [cs]);

  const h = useMemo(() => (pa && b ? headToHead(pa, b) : null), [pa, b]);
  const rows = useMemo(() => (pa && pb ? comparePlayers(pa, pb) : []), [pa, pb]);

  const pickers = showPickers && (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Picker label="Compare" pool={pool} value={a} blocked={b} onPick={(id) => onPick("a", id)} />
      <Picker label="With" pool={pool} value={b} blocked={a} onPick={(id) => onPick("b", id)} />
    </div>
  );

  if (!pa || !pb || !h) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {pickers}
        <div style={{ textAlign: "center", fontSize: 13, color: C.dim, padding: "40px 0" }}>Pick two players.</div>
      </div>
    );
  }

  const drawn = h.vs.wins === h.vs.losses;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {pickers}

      {/* the scoreline of the rivalry */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {[pa, pb].map((p, i) => {
          const won = i === 0 ? h.vs.wins > h.vs.losses : h.vs.losses > h.vs.wins;
          const cell = (
            <>
              <Avatar name={p.name} color={p.color} size={40} />
              <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%", color: won ? C.accent : C.fg }}>{p.name}</span>
              <span style={{ fontSize: 10, color: C.dimmer, fontFamily: "var(--font-mono)" }}>{!p.games ? "unranked" : p.provisional ? `placing · ${p.rating}` : p.rank ? `#${p.rank} · ${p.rating}` : `resting · ${p.rating}`}</span>
            </>
          );
          const style: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, background: "none", border: "none", padding: 0, order: i * 2 };
          return onOpenPlayer
            ? <button key={p.id} onClick={() => onOpenPlayer(p.id)} className={press} style={{ ...style, cursor: "pointer" }}>{cell}</button>
            : <div key={p.id} style={style}>{cell}</div>;
        })}
        <div style={{ textAlign: "center", flexShrink: 0, order: 1 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 800 }}>
            <span style={{ color: h.vs.wins >= h.vs.losses ? C.accent : C.fg }}>{h.vs.wins}</span>
            <span style={{ color: C.dim, fontSize: 20 }}>–</span>
            <span style={{ color: h.vs.losses > h.vs.wins ? C.accent : C.fg }}>{h.vs.losses}</span>
          </div>
          <div style={{ fontSize: 9.5, color: C.dimmer, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", marginTop: 2 }}>head to head</div>
        </div>
      </div>

      <div style={{ fontSize: 12, color: C.muted, textAlign: "center", lineHeight: 1.4 }}>
        {h.vs.games === 0
          ? `${pa.name} and ${pb.name} have never been on opposite sides.`
          : drawn
            ? `All square after ${h.vs.games} meeting${h.vs.games === 1 ? "" : "s"}.`
            : `${h.vs.wins > h.vs.losses ? pa.name : pb.name} leads it, ${Math.max(h.vs.wins, h.vs.losses)}–${Math.min(h.vs.wins, h.vs.losses)}.`}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <MiniFact label="as partners" value={h.with.games ? `${h.with.wins}–${h.with.losses}` : "–"} sub={h.with.games ? `${h.with.games} together` : "never paired"} color={C.fg} />
        <MiniFact label="points" value={h.vs.games ? `${h.vs.pf}–${h.vs.pa}` : "–"} sub="when opposed" color={C.fg} />
        <MiniFact label="rating swing" value={`${h.swing >= 0 ? "+" : ""}${h.swing}`} sub={`${pa.name} net`} color={h.swing > 0 ? C.win : h.swing < 0 ? C.loss : C.fg} />
      </div>

      {/* careers side by side — the leader on each line in lime */}
      <div style={{ background: C.surface, border: "1px solid rgba(255,255,255,.06)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, alignItems: "center", padding: "10px 13px", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: C.accent, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pa.name}</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: C.dimmer, letterSpacing: ".06em" }}>VS</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: C.accent, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pb.name}</span>
        </div>
        {rows.map((r) => (
          <div key={r.key} style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, alignItems: "center", padding: "8px 13px", borderBottom: "1px solid rgba(255,255,255,.035)" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: r.lead === "a" ? 800 : 600, color: r.lead === "a" ? C.accent : C.num }}>{r.a}</span>
            <span style={{ fontSize: 10.5, color: C.dim, textAlign: "center", whiteSpace: "nowrap" }}>{r.label}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: r.lead === "b" ? 800 : 600, color: r.lead === "b" ? C.accent : C.num, textAlign: "right" }}>{r.b}</span>
          </div>
        ))}
      </div>

      {/* the games themselves, kept apart: against is the rivalry, together is the partnership */}
      <Disclosure title="Games against each other" teaser={`${h.vs.games}`} defaultOpen={h.vs.games > 0}>
        {h.vsGames.length === 0
          ? <div style={{ fontSize: 12.5, color: C.dim, padding: "8px 0" }}>They&apos;ve never played against each other.</div>
          : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[...h.vsGames].reverse().map((e) => (
                <ResultRow key={e.id} m={asResult(pa, e)} resolve={(id) => ({ name: cs.st[id]?.name ?? "?", color: cs.st[id]?.color ?? "#888" })} onOpen={onOpenMatch ? () => onOpenMatch(e.id) : undefined} />
              ))}
            </div>
          )}
      </Disclosure>

      <Disclosure title="Games as partners" teaser={`${h.with.games}`}>
        {h.withGames.length === 0
          ? <div style={{ fontSize: 12.5, color: C.dim, padding: "8px 0" }}>They&apos;ve never played together.</div>
          : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[...h.withGames].reverse().map((e) => (
                <ResultRow key={e.id} m={asResult(pa, e)} resolve={(id) => ({ name: cs.st[id]?.name ?? "?", color: cs.st[id]?.color ?? "#888" })} onOpen={onOpenMatch ? () => onOpenMatch(e.id) : undefined} />
              ))}
            </div>
          )}
      </Disclosure>
    </div>
  );
}
