import type { AgentDrizzleDatabase } from "../../database-types.js";
import { ambientDatabase } from "../../transaction-context.js";

export abstract class DrizzleRepositoryBase {
  protected constructor(private readonly rootDatabase: AgentDrizzleDatabase) {}

  /** Always select the ambient connection so repository callers stay transaction-transparent. */
  protected db(): AgentDrizzleDatabase {
    return ambientDatabase(this.rootDatabase);
  }
}
