-- Make the host server identity explicit for every newly stored pane.
CREATE TABLE `panes_new` (
	`id` text PRIMARY KEY NOT NULL,
	`tmux_pane_id` text NOT NULL,
	`tmux_server_id` text NOT NULL,
	`agent_session_id` text,
	`agent_execution_id` text,
	`session_name` text NOT NULL,
	`window_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`cwd` text NOT NULL,
	`workspace_id` text,
	`agent_id` text,
	`state` text NOT NULL,
	`title` text,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `panes_new` (
	`id`,
	`tmux_pane_id`,
	`tmux_server_id`,
	`agent_session_id`,
	`agent_execution_id`,
	`session_name`,
	`window_id`,
	`kind`,
	`name`,
	`cwd`,
	`workspace_id`,
	`agent_id`,
	`state`,
	`title`,
	`last_seen_at`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`tmux_pane_id`,
	`tmux_server_id`,
	`agent_session_id`,
	`agent_execution_id`,
	`session_name`,
	`window_id`,
	`kind`,
	`name`,
	`cwd`,
	`workspace_id`,
	`agent_id`,
	`state`,
	`title`,
	`last_seen_at`,
	`created_at`,
	`updated_at`
FROM `panes`;
--> statement-breakpoint
DROP TABLE `panes`;
--> statement-breakpoint
ALTER TABLE `panes_new` RENAME TO `panes`;
--> statement-breakpoint
CREATE UNIQUE INDEX `panes_tmux_server_pane_id_index` ON `panes` (`tmux_server_id`,`tmux_pane_id`);
--> statement-breakpoint
CREATE INDEX `panes_agent_session_index` ON `panes` (`agent_session_id`);
