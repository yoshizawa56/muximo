CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`executor` text NOT NULL,
	`state` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`idempotency_key` text,
	`subject` text,
	`result` text,
	`error` text,
	`diagnostic` text,
	`log_reference` text,
	`cancel_requested_at` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_kind_idempotency_key_index` ON `operations` (`kind`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `operations_state_index` ON `operations` (`state`);