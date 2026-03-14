CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_key` text NOT NULL,
	`gateway_url` text NOT NULL,
	`entry_id` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_chat_messages_entry_id` ON `chat_messages` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_messages_session_ts` ON `chat_messages` (`session_key`,`timestamp_ms`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon` text NOT NULL,
	`color` text NOT NULL,
	`template_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_teams_name` ON `teams` (`name`);--> statement-breakpoint
ALTER TABLE `agents` ADD `team_id` text REFERENCES teams(id);--> statement-breakpoint
CREATE INDEX `idx_agents_team_id` ON `agents` (`team_id`);