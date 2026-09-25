-- Agent proposals (spec docs/specs/2026-09-25-agent-proposals.md): a task
-- command an agent proposes and the owner answers with «да» or «нет», kept
-- apart from the board. A new table, nothing to backfill: an existing
-- database has no proposals. The fingerprint is unique for all time (a
-- refusal holds); a number belongs to one shown proposal at a time.
-- Data rule (variant b): upgradeExport gives exports of formats 1-8 an empty
-- list, validateExport replays proposal events like any record.
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`task_id` text,
	`base_revision` integer,
	`command` text NOT NULL,
	`reason` text NOT NULL,
	`evidence` text NOT NULL,
	`fingerprint` text NOT NULL,
	`rank` integer NOT NULL,
	`status` text NOT NULL,
	`number` integer,
	`shown_on` text,
	`decided_at` text,
	`decided_by` text,
	`decided_by_label` text,
	`decision_reason` text,
	`patch` text,
	`result_task_id` text,
	`created_by` text NOT NULL,
	`created_by_label` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_fingerprint` ON `proposals` (`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_number` ON `proposals` (`number`) WHERE number IS NOT NULL;
