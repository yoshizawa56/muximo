CREATE TABLE `agent_execution_receipts` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`agent_session_id` text NOT NULL,
	`operation` text NOT NULL,
	`process` text NOT NULL,
	`session` text NOT NULL,
	`cleanup` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
