-- operation_seq: position in the operation journal, assigned with the result
-- and independent of domain events (TI-008). SQLite cannot add a NOT NULL
-- column without a default, so the table is rebuilt; the column list and the
-- indexes follow the drizzle-kit snapshot 0002, the copy with the backfill in
-- (created_at, id) order is written by hand (see drizzle/v2/README.md).
-- Data rule: no domain values change, replay stays equal to the tables, so
-- applyEvent/validateExport need no default for this column; an export of the
-- previous format gets the same positions from admin.upgradeExport.
CREATE TABLE `__new_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_seq` integer NOT NULL,
	`actor_id` text NOT NULL,
	`actor_label` text NOT NULL,
	`command` text NOT NULL,
	`command_hash` text NOT NULL,
	`status` integer NOT NULL,
	`result` text NOT NULL,
	`first_seq` integer,
	`last_seq` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_operations` (`id`, `operation_seq`, `actor_id`, `actor_label`, `command`, `command_hash`, `status`, `result`, `first_seq`, `last_seq`, `created_at`)
SELECT `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `id`), `actor_id`, `actor_label`, `command`, `command_hash`, `status`, `result`, `first_seq`, `last_seq`, `created_at`
FROM `operations`;
--> statement-breakpoint
DROP TABLE `operations`;
--> statement-breakpoint
ALTER TABLE `__new_operations` RENAME TO `operations`;
--> statement-breakpoint
CREATE INDEX `operations_created` ON `operations` (`created_at`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_seq` ON `operations` (`operation_seq`);
