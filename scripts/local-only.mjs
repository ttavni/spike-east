// Scripts that write fake games (and seed-demo, which deletes the real ones first) must never
// reach a real league. Called at the top of each; refuses anything but a database on this machine.
export function assertLocalDatabase() {
  let host = "";
  try {
    host = new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    // unset or unparsable: refused below
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    console.error(`Refusing to run against "${host || "no DATABASE_URL"}": this script is for a local database only.`);
    process.exit(1);
  }
}
