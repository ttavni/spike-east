import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { db } from "./index";
import { players } from "./schema";
import { hashPin, sharedCode } from "../lib/auth/pin";

// Bootstrap roster. After this, add/remove players in-app (Me -> Manage players).
// Colours from the Spike palette.
const PLAYERS = [
  { name: "tim", displayName: "Tim", color: "#BEF264", isAdmin: true },
  { name: "izzy", displayName: "Izzy", color: "#5EEAD4" },
  { name: "will", displayName: "Will", color: "#F9A8D4" },
  { name: "benl", displayName: "Ben L", color: "#93C5FD" },
  { name: "beng", displayName: "Ben G", color: "#FDA4AF" },
  { name: "sahil", displayName: "Sahil", color: "#FCD34D" },
  { name: "joss", displayName: "Joss", color: "#C4B5FD" },
];

// Sign-in checks SPIKE_PIN itself; rows still carry a hash of it so an older build can be rolled
// back to without locking everyone out.
const SHARED_PIN = sharedCode() ?? "";
if (!SHARED_PIN) {
  throw new Error("Set SPIKE_PIN (the shared 4-8 digit sign-in code) before seeding production.");
}

async function main() {
  console.log("Seeding…");
  const existing = await db.select().from(players);
  const names = new Set(existing.map((p) => p.name));
  const pinHash = await hashPin(SHARED_PIN);
  for (const p of PLAYERS) {
    if (names.has(p.name)) continue;
    await db.insert(players).values({ name: p.name, displayName: p.displayName, color: p.color, isAdmin: p.isAdmin ?? false, pinHash });
    console.log(`  ✓ ${p.displayName}`);
  }
  console.log(`Done. Shared sign-in code is ${SHARED_PIN}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
