// Admin is a second lock, not a second account. Everyone signs in with the one shared code, so
// "signed in as Tim" proves nothing. An admin player additionally types the admin code
// (SPIKE_ADMIN_CODE, known only to admins, never sent to the client) and their signed session
// cookie is marked unlocked for ADMIN_HOURS. Every admin server action checks that mark.
//
// Pure, so it's tested directly; the cookie and the env var are read by the callers.

import { createHash, timingSafeEqual } from "node:crypto";

/** How long one unlock lasts: a night at the court, not forever on a phone that gets passed round. */
export const ADMIN_HOURS = 12;

/** Shorter than this and the admin code is as guessable as the shared sign-in code. */
export const ADMIN_CODE_MIN = 8;

/**
 * Does the typed code match the configured one? Compared as hashes in constant time, so neither
 * the length nor the first wrong character leaks through timing. Never matches when no code is
 * configured, or when the configured one is too short to be worth having.
 */
export function adminCodeMatches(typed: string, configured: string | undefined): boolean {
  if (!configured || configured.length < ADMIN_CODE_MIN) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(typed), digest(configured));
}

/** Is a session's admin unlock still in force? */
export function adminActive(adminUntil: number | undefined | null, now: number): boolean {
  return typeof adminUntil === "number" && adminUntil > now;
}
