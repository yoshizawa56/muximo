export interface TransactionManager {
  /**
   * Runs one application-owned, database-only atomic scope.
   *
   * Implementations may retry the complete operation after a transient
   * database lock, so callers must not perform external side effects here.
   * Repository and database-audit ports may be awaited; terminal, network,
   * provider, filesystem, and authentication-service calls must stay outside.
   */
  run<Result>(operation: () => Promise<Result>): Promise<Result>;
}
