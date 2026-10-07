import "server-only";
import { after } from "next/server";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { ratingCache } from "@/db/schema";
import { ledgerStillFits, unpackLedger, type LeagueMatch, type LeaguePlayer } from "@/lib/league";
import { buildRatings, isCurrent, scopeGames, RATING_KEY, type CachedScope, type ScopeRatings } from "@/lib/ratingCache";
import type { Season } from "@/lib/season";

// Where the ratings live between requests. Two levels:
//   1. this process's memory — a warm instance answers with no query and no maths;
//   2. the rating_cache table — a cold instance (most of them, on a quiet serverless league)
//      reads one row per stale view instead of refitting the whole history.
// Only on a genuine change (a game logged, edited or deleted) is anything computed, and then
// only the views that game falls in, extending their ledgers by a warm fit. The result goes
// back to the table after the response, so the next cold instance finds it.
//
// rating_cache is derived data: truncating it is always safe — it rebuilds itself.

let memory = new Map<string, CachedScope>();

/** One line, not the failed query: drizzle's error carries the whole packed ledger in its params. */
const why = (e: unknown) => {
  const err = e as { cause?: { message?: string }; message?: string };
  return (err?.cause?.message ?? err?.message ?? String(e)).slice(0, 200);
};

export async function getRatings(
  players: LeaguePlayer[],
  matches: LeagueMatch[],
  seasons: Season[],
): Promise<Record<string, ScopeRatings>> {
  const views = scopeGames(players, matches, seasons);
  const stale = views.filter((v) => !isCurrent(memory.get(v.key), v.sig));
  if (stale.length) {
    try {
      const rows = await db
        .select()
        .from(ratingCache)
        .where(and(eq(ratingCache.model, RATING_KEY), inArray(ratingCache.scope, stale.map((v) => v.key))));
      const loaded = new Map<string, CachedScope>();
      let trusted = true;
      for (const row of rows) {
        const view = stale.find((v) => v.key === row.scope)!;
        if (row.model !== RATING_KEY) continue;
        const ledger = row.ledger ? unpackLedger(row.ledger) : null;
        // A row is only as good as the model that wrote it. Re-fit its last game under this
        // build's code before trusting it, so a change to rating.ts can never serve old numbers —
        // and if one row fails, the same old code wrote the rest (rank ranges included), so none
        // of them is used.
        if (ledger && !ledgerStillFits(players, view.matches, ledger, view.fresh)) { trusted = false; break; }
        loaded.set(row.scope, { model: row.model, sig: row.sig, ledger, packed: row.ledger, rankRanges: row.rankRanges });
      }
      if (trusted) for (const [k, c] of loaded) memory.set(k, c);
    } catch (e) {
      // An optimisation, never a dependency: with no cache the ratings are simply computed.
      console.error("rating_cache read failed:", why(e));
    }
  }

  const built = buildRatings(players, matches, seasons, memory);
  memory = built.cache;
  if (built.changed.length) {
    const rows = built.changed.map((key) => {
      const c = built.cache.get(key)!;
      return { scope: key, model: c.model, sig: c.sig, ledger: c.packed, rankRanges: c.rankRanges };
    });
    const persist = async () => {
      try {
        await db
          .insert(ratingCache)
          .values(rows)
          .onConflictDoUpdate({
            target: [ratingCache.scope, ratingCache.model],
            set: {
              sig: sql`excluded.sig`,
              ledger: sql`excluded.ledger`,
              rankRanges: sql`excluded.rank_ranges`,
              updatedAt: sql`now()`,
            },
          });
        // Rows from other builds (old deploys, a preview sharing this database) once they've
        // gone a fortnight untouched. This build's own rows are never pruned.
        await db
          .delete(ratingCache)
          .where(and(ne(ratingCache.model, RATING_KEY), lt(ratingCache.updatedAt, sql`now() - interval '14 days'`)));
      } catch (e) {
        console.error("rating_cache write failed:", why(e));
      }
    };
    // After the response, so a page is never held up writing a cache it has already used.
    try { after(persist); } catch { void persist(); }
  }
  return built.ratings;
}
