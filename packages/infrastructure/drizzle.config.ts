import { defineConfig } from "drizzle-kit";
import { resolveMuximodPaths } from "./src/persistence/paths.js";

const configuredDatabase = [
  process.env.MUXIMOD_INSTANCE_DIR,
  process.env.MUXIMOD_DB_FILE,
  process.env.MUXIMO_DATABASE_FILE,
].some((value) => Boolean(value?.trim()));

export default defineConfig({
  out: "./drizzle",
  schema: "./src/persistence/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: configuredDatabase ? resolveMuximodPaths(process.env).databaseFile : "./muximod.sqlite",
  },
});
