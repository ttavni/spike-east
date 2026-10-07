import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Next.js convention: .env.local overrides .env for local dev.
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
