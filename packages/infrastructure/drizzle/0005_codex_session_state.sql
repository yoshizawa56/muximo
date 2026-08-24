CREATE TABLE `codex_session_states` (
	`agent_session_id` text PRIMARY KEY NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
	`profile` text,
	`remote` text,
	`session_baseline` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `codex_session_states` (
	`agent_session_id`,
	`profile`,
	`remote`,
	`session_baseline`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`codex_profile`,
	`codex_remote`,
	`codex_session_baseline`,
	`created_at`,
	`updated_at`
FROM `agent_sessions`
WHERE `codex_profile` IS NOT NULL
	OR `codex_remote` IS NOT NULL
	OR `codex_session_baseline` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_sessions` DROP COLUMN `codex_profile`;
--> statement-breakpoint
ALTER TABLE `agent_sessions` DROP COLUMN `codex_remote`;
--> statement-breakpoint
ALTER TABLE `agent_sessions` DROP COLUMN `codex_session_baseline`;
