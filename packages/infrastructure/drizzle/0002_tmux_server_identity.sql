ALTER TABLE `panes` ADD `tmux_server_id` text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
DROP INDEX `panes_tmux_pane_id_index`;
--> statement-breakpoint
CREATE UNIQUE INDEX `panes_tmux_server_pane_id_index` ON `panes` (`tmux_server_id`,`tmux_pane_id`);
