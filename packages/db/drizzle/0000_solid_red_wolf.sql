CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gateway_id` text NOT NULL,
	`avatar_seed` text,
	`personality_config` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agents_gateway_id` ON `agents` (`gateway_id`);--> statement-breakpoint
CREATE INDEX `idx_agents_status` ON `agents` (`status`);--> statement-breakpoint
CREATE TABLE `approval_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`action` text NOT NULL,
	`tool_name` text NOT NULL,
	`details` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_approval_history_agent_id` ON `approval_history` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_approval_history_created_at` ON `approval_history` (`created_at`);--> statement-breakpoint
CREATE TABLE `cost_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_cost_records_agent_id` ON `cost_records` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_cost_records_run_id` ON `cost_records` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_cost_records_created_at` ON `cost_records` (`created_at`);--> statement-breakpoint
CREATE TABLE `graph_layouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text DEFAULT 'default' NOT NULL,
	`gateway_url` text NOT NULL,
	`layout_data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_graph_layouts_name_url` ON `graph_layouts` (`name`,`gateway_url`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`category` text,
	`trust_score` real,
	`installed_at` integer,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `idx_skills_source` ON `skills` (`source`);--> statement-breakpoint
CREATE INDEX `idx_skills_category` ON `skills` (`category`);--> statement-breakpoint
CREATE TABLE `team_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`agents_config` text NOT NULL,
	`skills_config` text NOT NULL,
	`graph_layout` text,
	`is_builtin` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
