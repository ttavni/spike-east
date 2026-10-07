import { describe, it, expect } from "vitest";
import { adminActive, adminCodeMatches, ADMIN_CODE_MIN } from "./admin";

describe("adminCodeMatches", () => {
  const code = "rim-pocket-spike";

  it("accepts the configured code exactly", () => {
    expect(adminCodeMatches(code, code)).toBe(true);
  });

  it("refuses anything else, including near misses and other lengths", () => {
    expect(adminCodeMatches("rim-pocket-spikE", code)).toBe(false);
    expect(adminCodeMatches(code + " ", code)).toBe(false);
    expect(adminCodeMatches("", code)).toBe(false);
    expect(adminCodeMatches("0000", code)).toBe(false);
  });

  it("stays locked when no code is configured, rather than letting anything through", () => {
    expect(adminCodeMatches("", undefined)).toBe(false);
    expect(adminCodeMatches("", "")).toBe(false);
    expect(adminCodeMatches("anything", undefined)).toBe(false);
  });

  it("won't use a configured code too short to be worth having", () => {
    const short = "1".repeat(ADMIN_CODE_MIN - 1);
    expect(adminCodeMatches(short, short)).toBe(false);
    const ok = "1".repeat(ADMIN_CODE_MIN);
    expect(adminCodeMatches(ok, ok)).toBe(true);
  });
});

describe("adminActive", () => {
  const now = Date.UTC(2026, 9, 6, 20);

  it("is on until the moment it runs out, and off from then", () => {
    expect(adminActive(now + 1, now)).toBe(true);
    expect(adminActive(now, now)).toBe(false);
    expect(adminActive(now - 1, now)).toBe(false);
  });

  it("is off for a session that was never unlocked", () => {
    expect(adminActive(undefined, now)).toBe(false);
    expect(adminActive(null, now)).toBe(false);
  });
});
