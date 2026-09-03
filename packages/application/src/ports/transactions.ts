import type { ApplicationEffect } from "../effect.js";

export interface TransactionManager {
  /**
   * Runs one application-owned, database-only atomic scope.
   *
   * Implementations may retry the complete operation after a transient
   * database lock, so callers must not perform external side effects here.
   * Repository and database-audit ports may be yielded; terminal, network,
   * provider, filesystem, and authentication-service calls must stay outside.
   *
   * The operation must require no services: resolve Context services before
   * calling run and close over the resolved values, so the scope stays
   * executable (including retries) without ambient service propagation.
   */
  run<A>(operation: ApplicationEffect<A>): ApplicationEffect<A>;
}
