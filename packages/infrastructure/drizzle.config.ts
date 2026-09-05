import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/persistence/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.MUXIMOD_DATABASE_FILE?.trim() || "./muximod.sqlite",
  },
});
