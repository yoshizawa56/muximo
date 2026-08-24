ALTER TABLE `panes` ADD `agent_session_id` text;
--> statement-breakpoint
ALTER TABLE `panes` ADD `agent_execution_id` text;
--> statement-breakpoint
CREATE INDEX `panes_agent_session_index` ON `panes` (`agent_session_id`);
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `execution_id` text;
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `execution_pid` integer;
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `execution_started_at` text;
