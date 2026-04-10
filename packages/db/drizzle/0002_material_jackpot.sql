ALTER TABLE `teams` ADD `leader_agent_id` text;--> statement-breakpoint
ALTER TABLE `teams` ADD `is_archived` integer DEFAULT 0 NOT NULL;