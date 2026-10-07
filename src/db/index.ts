import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// postgres.js works against both local Postgres and Neon's pooled connection.
// Reuse a single client across hot reloads in dev.
const globalForDb = globalThis as unknown as { _spikeSql?: ReturnType<typeof postgres> };

const sql =
  globalForDb._spikeSql ??
  postgres(connectionString, {
    max: 10,
    // Neon pooled connections require SSL; local does not. Auto-detect by host.
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
      ? false
      : "require",
  });

if (process.env.NODE_ENV !== "production") globalForDb._spikeSql = sql;

export const db = drizzle(sql, { schema });
export { schema };
