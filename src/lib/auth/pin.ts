import { createHash, scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

// ---- the shared sign-in code ----
// Everyone signs in with one code, SPIKE_PIN: 4 to 8 digits. It's checked against the server's
// env on every attempt, so changing it (or lengthening it) is a matter of changing the env var
// and redeploying. Attempts are rate-limited by src/lib/auth/attempts.ts — at four digits the
// limits are what stop the code being guessed, so prefer six or more.

/** A valid shared code: 4 to 8 digits. */
export const CODE_RE = /^\d{4,8}$/;

/** The shared code in force, or null when sign-in isn't set up. Development falls back to
 *  0000; production never does — a missing or malformed SPIKE_PIN closes sign-in instead. */
export function sharedCode(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.SPIKE_PIN?.trim();
  if (v && CODE_RE.test(v)) return v;
  return env.NODE_ENV === "production" ? null : "0000";
}

/** How many digits the keypad asks for. Only the length leaves the server, never the code. */
export function sharedCodeLength(env: NodeJS.ProcessEnv = process.env): number {
  return sharedCode(env)?.length ?? 4;
}

/** Compared as hashes in constant time, so neither the length nor the first wrong digit leaks
 *  through timing. Never matches when no code is configured. */
export function sharedCodeMatches(typed: unknown, configured: string | null): boolean {
  if (!configured || typeof typed !== "string") return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(typed), digest(configured));
}

/**
 * PIN hashing with Node's built-in scrypt (no native deps). Format:
 *   scrypt$<saltHex>$<hashHex>
 * Players' rows still carry a hash of the shared code (the column predates the env check, and it
 * keeps a rollback to the older per-row check working), but sign-in no longer reads it.
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(pin, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const derived = (await scryptAsync(pin, salt, 64)) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
