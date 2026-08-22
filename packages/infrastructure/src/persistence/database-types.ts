import { drizzle } from "drizzle-orm/bun-sqlite";

export type AgentDrizzleDatabase = ReturnType<typeof drizzle>;
