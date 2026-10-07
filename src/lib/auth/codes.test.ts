import { describe, it, expect } from "vitest";
import { sharedCode, sharedCodeLength, sharedCodeMatches } from "./pin";
import { LIMITS, refusedFor, tooManyMessage } from "./limits";

const env = (vars: Record<string, string | undefined>) => ({ ...vars }) as unknown as NodeJS.ProcessEnv;

describe("sharedCode", () => {
  it("takes 4 to 8 digits from SPIKE_PIN", () => {
    expect(sharedCode(env({ SPIKE_PIN: "4821", NODE_ENV: "production" }))).toBe("4821");
    expect(sharedCode(env({ SPIKE_PIN: "48213377", NODE_ENV: "production" }))).toBe("48213377");
    expect(sharedCodeLength(env({ SPIKE_PIN: "482133", NODE_ENV: "production" }))).toBe(6);
  });

  it("closes sign-in in production rather than falling back to a default", () => {
    for (const bad of [undefined, "", "123", "123456789", "12a4", " "]) {
      expect(sharedCode(env({ SPIKE_PIN: bad, NODE_ENV: "production" }))).toBeNull();
    }
    expect(sharedCodeLength(env({ NODE_ENV: "production" }))).toBe(4);
  });

  it("falls back to 0000 only in development", () => {
    expect(sharedCode(env({ NODE_ENV: "development" }))).toBe("0000");
    expect(sharedCode(env({}))).toBe("0000");
  });
});

describe("sharedCodeMatches", () => {
  it("accepts the code exactly and nothing else", () => {
    expect(sharedCodeMatches("4821", "4821")).toBe(true);
    for (const wrong of ["4822", "482", "48210", "", " 4821", "4821 "]) expect(sharedCodeMatches(wrong, "4821")).toBe(false);
  });

  it("never matches when sign-in isn't set up, or when the caller sends something that isn't text", () => {
    expect(sharedCodeMatches("0000", null)).toBe(false);
    for (const junk of [undefined, null, 4821, ["4821"], { pin: "4821" }]) expect(sharedCodeMatches(junk, "4821")).toBe(false);
  });
});

describe("rate limits", () => {
  const now = Date.UTC(2026, 9, 6, 20);
  const p = LIMITS.codeIp;

  // `hits` includes the try being judged: the upsert counts it before anything is checked.
  it("allows tries up to the limit, then refuses for the rest of the window", () => {
    expect(refusedFor({ hits: 1, windowStart: now }, p, now)).toBe(0);
    expect(refusedFor({ hits: p.max, windowStart: now - 1000 }, p, now)).toBe(0);
    expect(refusedFor({ hits: p.max + 1, windowStart: now - 1000 }, p, now)).toBe(p.windowMs - 1000);
    expect(refusedFor({ hits: p.max + 50, windowStart: now - 1000 }, p, now)).toBe(p.windowMs - 1000);
  });

  it("never reports a refusal as a zero wait, even with the database's clock ahead of ours", () => {
    expect(refusedFor({ hits: p.max + 1, windowStart: now - p.windowMs - 5000 }, p, now)).toBe(1);
  });

  it("caps the league as a whole above any one caller, and the admin code harder than the shared one", () => {
    expect(LIMITS.codeAll.max).toBeGreaterThan(LIMITS.codeIp.max);
    expect(LIMITS.adminAll.max).toBeGreaterThan(LIMITS.adminIp.max);
    expect(LIMITS.adminIp.max / LIMITS.adminIp.windowMs).toBeLessThan(LIMITS.codeIp.max / LIMITS.codeIp.windowMs);
  });

  it("makes guessing a 6-digit code take months even across many IPs", () => {
    // Expected tries to hit a uniformly random code: half the space.
    const perHour = LIMITS.codeAll.max * (3_600_000 / LIMITS.codeAll.windowMs);
    expect(1_000_000 / 2 / perHour / 24).toBeGreaterThan(60); // days
  });

  it("leaves a busy night's logging and planning well inside the per-IP caps", () => {
    // Five courts finishing a game every ~12 minutes, all logged over one venue's WiFi.
    expect(LIMITS.logIp.max * (3_600_000 / LIMITS.logIp.windowMs)).toBeGreaterThanOrEqual(2 * 25);
    // A replan every time someone arrives or leaves, a dozen people turning up in ten minutes.
    expect(LIMITS.planIp.max * (600_000 / LIMITS.planIp.windowMs)).toBeGreaterThanOrEqual(2 * 12);
  });

  it("says how long to wait in whole minutes", () => {
    expect(tooManyMessage(1)).toBe("Too many tries. Try again in 1 minute.");
    expect(tooManyMessage(14 * 60_000 + 1)).toBe("Too many tries. Try again in 15 minutes.");
    expect(tooManyMessage(90_000, "games logged")).toBe("Too many games logged. Try again in 2 minutes.");
  });
});
