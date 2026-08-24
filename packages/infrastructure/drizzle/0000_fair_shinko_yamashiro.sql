CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`backend` text NOT NULL,
	`status` text NOT NULL,
	`workspace_id` text NOT NULL,
	`workspace_root` text NOT NULL,
	`workspace_name` text NOT NULL,
	`worktree_root` text,
	`worktree_path` text,
	`branch` text,
	`base_commit` text,
	`use_worktree` integer NOT NULL,
	`setup_hook` text,
	`cleanup_hook` text,
	`setup_output_file` text,
	`cleanup_output_file` text,
	`backend_session_id` text,
	`codex_profile` text,
	`codex_remote` text,
	`setup_ran` integer NOT NULL,
	`resuming` integer NOT NULL,
	`baseline_status` text,
	`codex_session_baseline` text,
	`last_exit_status` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_workspace_name_index` ON `agent_sessions` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `agent_sessions_workspace_index` ON `agent_sessions` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `panes` (
	`id` text PRIMARY KEY NOT NULL,
	`tmux_pane_id` text NOT NULL,
	`session_name` text NOT NULL,
	`window_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`cwd` text NOT NULL,
	`workspace_id` text,
	`agent_id` text,
	`run_id` text,
	`state` text NOT NULL,
	`title` text,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `panes_tmux_pane_id_index` ON `panes` (`tmux_pane_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`pane_id` text NOT NULL,
	`agent_id` text,
	`profile_id` text,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`name` text NOT NULL,
	`is_git` integer NOT NULL,
	`setup_script_path` text,
	`cleanup_script_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
