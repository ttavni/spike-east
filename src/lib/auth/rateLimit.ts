import "server-only";
import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import { after } from "next/server";
import { eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import { LIMITS, refusedFor, tooManyMessage, type LimitPolicy } from "@/lib/auth/limits";

// The counting behind limits.ts. Counts live in the rate_limits table because serverless
// instances share no memory: a limit kept in process would reset with every cold start and could
// be dodged by spreading tries across instances. IPs are stored only as a keyed hash, never raw.
//
// If the table can't be reached the try is let through, and logged: the codes still have to
// match, and a database hiccup (or a deploy that beat its migration) shouldn't lock the league out.

/** The caller's IP, as a keyed hash. On Vercel x-forwarded-for is set by the platform, which
 *  overwrites anything a client sends, so it can't be spoofed to dodge a limit. */
async function clientKey(): Promise<string> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  return createHmac("sha256", process.env.AUTH_SECRET || "dev").update(ip).digest("hex").slice(0, 32);
}

const logFailure = (e: unknown) => console.error("rate_limits unavailable:", (e as Error)?.message?.slice(0, 200));

/**
 * Count one try in each bucket, in order, and stop at the first that refuses it: returns that
 * bucket's wait, or 0 to go ahead. In order, narrowest first, so a caller already over its own
 * limit never spends the league's: otherwise one IP could keep going and lock everyone out.
 */
async function take(buckets: [string, LimitPolicy][]): Promise<number> {
  let swept = false;
  for (const [bucket, p] of buckets) {
    // One atomic upsert: a window that has run out starts again at 1.
    const expired = sql`${rateLimits.windowStart} < now() - (${p.windowMs / 1000} * interval '1 second')`;
    const [row] = await db
      .insert(rateLimits)
      .values({ bucket, hits: 1, windowStart: sql`now()` })
      .onConflictDoUpdate({
        target: rateLimits.bucket,
        set: {
          hits: sql`case when ${expired} then 1 else ${rateLimits.hits} + 1 end`,
          windowStart: sql`case when ${expired} then now() else ${rateLimits.windowStart} end`,
        },
      })
      .returning({ hits: rateLimits.hits, windowStart: rateLimits.windowStart });
    // A new window means a new or reset row; that's the moment to sweep out ones nothing reads.
    if (row.hits === 1 && !swept) {
      swept = true;
      after(() => db.delete(rateLimits).where(lt(rateLimits.windowStart, sql`now() - interval '1 day'`)).catch(logFailure));
    }
    const wait = refusedFor({ hits: row.hits, windowStart: row.windowStart.getTime() }, p, Date.now());
    if (wait > 0) return wait;
  }
  return 0;
}

export type CodeAttempt = { ok: true; succeeded: () => void } | { ok: false; error: string };

/**
 * Count a try at the shared code or the admin code, BEFORE it's checked. Refused while the
 * caller's IP or the whole league is over its limit; otherwise call `succeeded` if the code was
 * right, which clears this IP's count and gives the try back to the league's.
 */
export async function codeAttempt(kind: "code" | "admin"): Promise<CodeAttempt> {
  const [ipPolicy, allPolicy] = kind === "code" ? [LIMITS.codeIp, LIMITS.codeAll] : [LIMITS.adminIp, LIMITS.adminAll];
  const ip = `${kind}:ip:${await clientKey()}`;
  const all = `${kind}:all`;
  try {
    const wait = await take([[ip, ipPolicy], [all, allPolicy]]);
    if (wait > 0) return { ok: false, error: tooManyMessage(wait) };
  } catch (e) {
    logFailure(e);
  }
  return {
    ok: true,
    succeeded: () =>
      after(() =>
        Promise.all([
          db.delete(rateLimits).where(eq(rateLimits.bucket, ip)),
          db.update(rateLimits).set({ hits: sql`greatest(${rateLimits.hits} - 1, 0)` }).where(eq(rateLimits.bucket, all)),
        ]).catch(logFailure),
      ),
  };
}

/** Count a write by a signed-in player against their IP's allowance (see LIMITS). */
export async function writeAllowed(kind: "log" | "plan"): Promise<{ ok: true } | { ok: false; error: string }> {
  const policy = kind === "log" ? LIMITS.logIp : LIMITS.planIp;
  try {
    const wait = await take([[`${kind}:ip:${await clientKey()}`, policy]]);
    if (wait > 0) return { ok: false, error: tooManyMessage(wait, kind === "log" ? "games logged" : "plans") };
  } catch (e) {
    logFailure(e);
  }
  return { ok: true };
}
