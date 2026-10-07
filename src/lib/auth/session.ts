import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

const COOKIE = "spike_session";
const ALG = "HS256";
const MAX_AGE = 60 * 60 * 24 * 60; // 60 days

/** The example value from .env.example: fine on a laptop, a skeleton key anywhere else. */
const EXAMPLE_SECRET = "dev-only-change-me-please-0000000000000000000000";

/**
 * The key every session cookie is signed with. Anyone who knows it can mint a session as any
 * player, admin unlock included, so production refuses to run on a short or published one
 * (generate a real one with `openssl rand -base64 32`).
 */
function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  if (process.env.NODE_ENV === "production" && (s.length < 32 || s === EXAMPLE_SECRET)) {
    throw new Error("AUTH_SECRET is too weak for production: use `openssl rand -base64 32`");
  }
  return new TextEncoder().encode(s);
}

/** `adminUntil` (epoch ms) is set only by unlockAdmin, after the admin code was typed. It lives
 *  inside the signed token, so a client can't forge or extend it. */
export type SessionPayload = { playerId: string; name: string; adminUntil?: number };

export async function createSession(playerId: string, name: string, adminUntil?: number): Promise<void> {
  const token = await new SignJWT(adminUntil ? { playerId, name, adminUntil } : { playerId, name })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    // HS256 only, and it must carry its own expiry: never let a token choose how it's checked.
    const { payload } = await jwtVerify<SessionPayload>(token, secret(), { algorithms: [ALG], requiredClaims: ["iat", "exp"] });
    return {
      playerId: payload.playerId,
      name: payload.name,
      adminUntil: typeof payload.adminUntil === "number" ? payload.adminUntil : undefined,
    };
  } catch (e) {
    // A weak production secret signs everyone out rather than taking the site down: say so loudly.
    if (e instanceof Error && e.message.startsWith("AUTH_SECRET")) console.error(e.message);
    return null;
  }
}
