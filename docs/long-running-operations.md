# Long-running muximod operations

Muximod keeps short, bounded RPCs synchronous. Work that can outlive an HTTP
request or a client control-socket connection is represented by a durable
operation in the `operations` table.

## Lifecycle

An operation has one of these states:

- `queued`: the operation identity has been allocated, but execution has not started.
- `running`: execution is in progress.
- `succeeded`: execution and its requested cleanup completed successfully.
- `failed`: execution ended with a structured error and optional diagnostic data.
- `cancelled`: cancellation was observed before the operation completed.

Operation identity is allocated before worktree creation, backend preparation,
archive, or restore work. The public status contains the operation ID, kind,
state, timestamps, result, structured error, diagnostic, log reference, and
cancellation timestamp. Request fingerprints, idempotency keys, and internal
subjects are daemon-owned fields.

The HTTP API exposes `operations.get` and `operations.cancel`. Long-running
public commands, such as `agentSessions.cleanup`, return an accepted operation
status. A client can poll `operations.get` after the original request has
ended. The CLI preserves the existing synchronous command behavior by waiting
for the accepted operation to reach a terminal state.

## Agent execution and PR #117

Interactive `muximo run` and `muximo session resume` remain CLI-owned because
the CLI must own the provider process's TTY. The private control protocol is
therefore split into three phases:

1. `prepare_agent_execution` allocates and starts a client-owned operation and
   prepares the session and command.
2. `attach_agent_execution` records the provider PID and starts daemon-side
   observation after the CLI has spawned the provider.
3. `complete_agent_execution` finalizes the session, stores a completion
   receipt, and settles the operation.

The private preparation response is cached by operation ID so a retry with the
same idempotency key can recover a lost response while the same daemon is
running. Prepared commands are not reconstructed after a daemon restart.

## Cancellation

Calling `operations.cancel` records `cancelRequestedAt` immediately. For a
client-owned agent execution, the CLI observes that timestamp and interrupts
its provider process. For daemon-owned cleanup, muximod aborts only the
pre-mutation phase.

Once cleanup starts mutating external state, cancellation does not replay or
roll back archive, hook, worktree, or resource operations. The cleanup runs to
an authoritative result; a late cancellation request remains visible on the
operation but does not replace that result. Process exit code `130`, `143`, or
an interrupted process is mapped to `cancelled`; other non-zero process exits
and cleanup failures are mapped to `failed`.

Client disconnects are not treated as cancellation. A disconnect during
preparation is recorded as `client_disconnected`. Once a client-owned
execution has been prepared, muximod uses the execution receipt and the CLI
owner process identity to reconcile it.

## Restart and retention

On startup:

- active daemon-owned operations are failed with `muximod_restarted`;
- a client-owned operation with a matching completion receipt is settled from
  that receipt;
- a client owner that is alive or whose liveness is unknown remains active;
- a dead client owner is failed with `client_execution_owner_lost`;
- active client operations without a reconstructable subject are failed with
  `muximod_restarted`.

Muximod does not replay provider work or cleanup hooks during reconciliation.
This avoids duplicating external mutations when the prior outcome is unknown.

Terminal operations and their completion receipts are retained for seven days
by default. A maintenance pass runs hourly and removes only terminal records
and receipts older than the retention window. Configure these values in
milliseconds with
`MUXIMOD_OPERATION_RETENTION_MS` and
`MUXIMOD_OPERATION_CLEANUP_INTERVAL_MS`. Idempotency is guaranteed while the
corresponding operation record is retained; after expiration, a repeated
request may allocate a new operation.
