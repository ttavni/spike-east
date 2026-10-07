"use client";

// Every game a player has played, newest first — filterable, and every row goes somewhere:
// the row itself opens the match sheet, the names inside it open profiles.
//
// No per-row layout animation on purpose. The profile mounts inside an AnimatePresence
// with mode="wait", so staggering forty rows every time you open a profile is jank you
// feel. The list fades in as a block instead.

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Avatar, C, press } from "@/components/spike/ui";
import type { MatchEntry, PlayerStat } from "@/lib/league";

type Filter = "all" | "won" | "lost";

const chip = (on: boolean): React.CSSProperties => ({
  fontSize: 11.5, fontWeight: 700, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
  background: on ? C.accent : "transparent",
  color: on ? C.ink : C.muted,
  border: `1px solid ${on ? C.accent : "rgba(255,255,255,.1)"}`,
});

export function GameHistory({
  entries, resolve, onOpenMatch, onOpenPlayer, pageSize = 20,
}: {
  entries: MatchEntry[];
  resolve: (id: string) => PlayerStat;
  onOpenMatch: (matchId: string) => void;
  onOpenPlayer: (playerId: string) => void;
  pageSize?: number;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [pinned, setPinned] = useState<string | null>(null);
  const [shown, setShown] = useState(pageSize);

  // Newest first. entries arrive chronological from the engine.
  const ordered = useMemo(() => [...entries].reverse(), [entries]);

  // Everyone in this history, most-played first. Rendering them all as chips stopped
  // scaling past a dozen players, so they're a typeahead now rather than a scroll row.
  const faces = useMemo(() => {
    const n = new Map<string, number>();
    for (const m of entries) for (const id of [m.partner, ...m.opps]) n.set(id, (n.get(id) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const needle = q.trim().toLowerCase();

  // Substring search alone can't separate "Ben L" from "Ben G" — so typing offers the
  // matching players, and picking one pins that exact id.
  const suggestions = useMemo(() => {
    if (pinned || !needle) return [];
    return faces.filter(([id]) => (resolve(id)?.name ?? "").toLowerCase().includes(needle)).slice(0, 6);
  }, [faces, needle, pinned, resolve]);

  const filtered = useMemo(() => ordered.filter((m) => {
    if (filter === "won" && !m.won) return false;
    if (filter === "lost" && m.won) return false;
    if (pinned) return m.partner === pinned || m.opps.includes(pinned);
    if (needle) {
      const names = [m.partner, ...m.opps].map((id) => (resolve(id)?.name ?? "").toLowerCase());
      if (!names.some((n) => n.includes(needle))) return false;
    }
    return true;
  }), [ordered, filter, needle, pinned, resolve]);

  const visible = filtered.slice(0, shown);
  const pick = (f: Filter) => { setFilter(f); setShown(pageSize); };
  const pinPlayer = (id: string) => { setPinned(id); setQ(""); setShown(pageSize); };
  const clearSearch = () => { setPinned(null); setQ(""); setShown(pageSize); };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: ".05em", textTransform: "uppercase" }}>All games</span>
        <span style={{ fontSize: 11, color: C.dimmer, fontFamily: "var(--font-mono)" }}>{filtered.length} of {entries.length}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <button onClick={() => pick("all")} className={press} style={chip(filter === "all")}>All</button>
        <button onClick={() => pick("won")} className={press} style={chip(filter === "won")}>Wins</button>
        <button onClick={() => pick("lost")} className={press} style={chip(filter === "lost")}>Losses</button>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          {pinned ? (
            // Pinned to one exact player — no ambiguity between the two Bens.
            <button
              onClick={clearSearch}
              className={press}
              style={{ width: "100%", height: 30, display: "flex", alignItems: "center", gap: 6, padding: "0 8px 0 3px", borderRadius: 999, background: "rgba(203,251,79,.12)", border: "1px solid rgba(203,251,79,.4)", cursor: "pointer" }}
            >
              <Avatar name={resolve(pinned)?.name ?? "?"} color={resolve(pinned)?.color ?? "#888"} size={24} />
              <span style={{ flex: 1, minWidth: 0, textAlign: "left", fontSize: 12, fontWeight: 700, color: C.accent, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{resolve(pinned)?.name ?? "?"}</span>
              <span style={{ fontSize: 12, color: C.accent, flexShrink: 0 }}>✕</span>
            </button>
          ) : (
            <>
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setShown(pageSize); }}
                placeholder="Search a player…"
                style={{
                  width: "100%", height: 30, borderRadius: 999, padding: "0 26px 0 12px",
                  background: C.panel, border: `1px solid ${needle ? "rgba(203,251,79,.35)" : "rgba(255,255,255,.1)"}`,
                  color: C.fg, fontSize: 12, fontWeight: 600, outline: "none",
                }}
              />
              {needle && (
                <button
                  onClick={clearSearch}
                  aria-label="Clear search"
                  style={{ position: "absolute", right: 2, top: 2, width: 26, height: 26, borderRadius: 999, background: "none", border: "none", color: C.dim, fontSize: 13, cursor: "pointer" }}
                >
                  ✕
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Rendered inline rather than as a floating dropdown: this list lives inside a
          Disclosure whose animating wrapper is overflow:hidden, which would clip it. */}
      {suggestions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
          {suggestions.map(([id, n]) => (
            <button
              key={id}
              onClick={() => pinPlayer(id)}
              className={press}
              style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 10px", borderRadius: 11, background: C.panel, border: "1px solid rgba(255,255,255,.07)", cursor: "pointer", textAlign: "left" }}
            >
              <Avatar name={resolve(id)?.name ?? "?"} color={resolve(id)?.color ?? "#888"} size={22} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{resolve(id)?.name ?? "?"}</span>
              <span style={{ fontSize: 10.5, color: C.dimmer, fontFamily: "var(--font-mono)", flexShrink: 0 }}>{n} game{n === 1 ? "" : "s"}</span>
            </button>
          ))}
        </div>
      )}

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {visible.length === 0 && (
          <div style={{ fontSize: 13, color: C.dim, padding: "18px 2px" }}>
            {pinned
              ? `No ${filter === "won" ? "wins" : filter === "lost" ? "losses" : "games"} with ${resolve(pinned)?.name ?? "them"}.`
              : needle
                ? `No games with anyone called “${q.trim()}”.`
                : `No ${filter === "won" ? "wins" : "losses"} yet.`}
          </div>
        )}
        {visible.map((m) => (
          <div
            key={`${m.idx}-${m.id}`}
            onClick={() => onOpenMatch(m.id)}
            className={press}
            style={{ display: "flex", alignItems: "center", gap: 11, background: C.surface, border: "1px solid rgba(255,255,255,.05)", borderRadius: 13, padding: "11px 13px", cursor: "pointer" }}
          >
            <div style={{ width: 30, height: 30, borderRadius: 9, background: m.won ? "rgba(92,211,125,.14)" : "rgba(255,107,107,.14)", color: m.won ? C.win : C.loss, fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{m.won ? "W" : "L"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                w/ <PlayerLink id={m.partner} resolve={resolve} onOpen={onOpenPlayer} />
              </div>
              <div style={{ fontSize: 11, color: C.dim, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                vs {m.opps.map((o, i) => (
                  <span key={o}>{i > 0 && " & "}<PlayerLink id={o} resolve={resolve} onOpen={onOpenPlayer} /></span>
                ))}
              </div>
              <div style={{ fontSize: 10, color: C.dimmer, marginTop: 3, fontFamily: "var(--font-mono)" }}>{m.date}</div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700 }}>{m.gf}–{m.ga}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: m.delta >= 0 ? C.win : C.loss, marginTop: 1 }}>{m.delta >= 0 ? "+" : ""}{m.delta}</div>
              {/* the rating you walked away with — read the column down the page to see the climb */}
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: C.dimmer, marginTop: 1 }}>{m.ratingAfter}</div>
            </div>
          </div>
        ))}
      </motion.div>

      {filtered.length > visible.length && (
        <button
          onClick={() => setShown(filtered.length)}
          className={press}
          style={{ width: "100%", marginTop: 10, height: 42, borderRadius: 12, background: "none", border: "1px solid rgba(255,255,255,.1)", color: C.muted, fontSize: 13, fontWeight: 700, cursor: "pointer" }}
        >
          Show all {filtered.length}
        </button>
      )}
    </div>
  );
}

/** A name inside a row that's already clickable — stop the tap reaching the match sheet. */
function PlayerLink({ id, resolve, onOpen }: { id: string; resolve: (id: string) => PlayerStat; onOpen: (id: string) => void }) {
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onOpen(id); }}
      style={{ color: "inherit", borderBottom: "1px dotted rgba(255,255,255,.22)", cursor: "pointer" }}
    >
      {resolve(id).name}
    </span>
  );
}
