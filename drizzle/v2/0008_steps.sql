-- Steps as records (TI-095, owner decision 2026-09-18). A step gets a
-- fractional order key inside its task instead of an integer position, the
-- moment and author of its tick, an outcome, the task it grew into, a soft
-- removal, the owner's protected fields and a revision of its own. SQLite
-- cannot add NOT NULL columns without a default, so the table is rebuilt; the
-- column list and the indexes follow the drizzle-kit snapshot 0008, the copy
-- with the backfill is written by hand (drizzle/v2/README.md).
-- Backfill: order_key is the key generateKeyBetween would have produced by
-- appending steps one after another ('a0'..'az', then 'b00'..), so existing
-- rows keep their order and new keys fit between them (legacyStepKey in
-- src/shared/steps.ts gives the same keys to legacy journal events and to
-- exports of formats 1-7); bookkeeping comes from the parent task, revision
-- is 1, nothing is owner-protected (the history keeps the owner's touches).
-- tasks.owner_fields loses "checklist": the task no longer owns that field.
-- Data rule (variant b): applyEvent turns pre-0008 checklist events into
-- these same records, validateExport compares steps as records,
-- upgradeExport converts the rows of formats 1-7.
CREATE TABLE `__new_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`text` text NOT NULL,
	`order_key` text NOT NULL,
	`done` integer NOT NULL,
	`done_at` text,
	`done_by` text,
	`done_by_label` text,
	`result` text DEFAULT '' NOT NULL,
	`linked_task_id` text,
	`removed_at` text,
	`created_by` text NOT NULL,
	`created_by_label` text NOT NULL,
	`owner_touched_at` text,
	`owner_fields` text DEFAULT '[]' NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_checklist_items` (`id`, `task_id`, `text`, `order_key`, `done`, `done_at`, `done_by`, `done_by_label`, `result`, `linked_task_id`, `removed_at`, `created_by`, `created_by_label`, `owner_touched_at`, `owner_fields`, `revision`, `created_at`, `updated_at`)
SELECT c.`id`, c.`task_id`, c.`text`,
  CASE WHEN c.`position` < 62
    THEN 'a' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', c.`position` + 1, 1)
    ELSE 'b0' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', c.`position` - 61, 1)
  END,
  c.`done`, NULL, NULL, NULL, '', NULL, NULL,
  t.`created_by`, t.`created_by_label`, NULL, '[]', 1, t.`created_at`, t.`created_at`
FROM `checklist_items` c JOIN `tasks` t ON t.`id` = c.`task_id`;
--> statement-breakpoint
DROP TABLE `checklist_items`;
--> statement-breakpoint
ALTER TABLE `__new_checklist_items` RENAME TO `checklist_items`;
--> statement-breakpoint
CREATE UNIQUE INDEX `checklist_order` ON `checklist_items` (`task_id`,`order_key`) WHERE removed_at IS NULL;
--> statement-breakpoint
CREATE INDEX `checklist_task` ON `checklist_items` (`task_id`);
--> statement-breakpoint
UPDATE `tasks` SET `owner_fields` = (
  SELECT json_group_array(value ORDER BY key) FROM json_each(`tasks`.`owner_fields`) WHERE value <> 'checklist'
) WHERE EXISTS (SELECT 1 FROM json_each(`tasks`.`owner_fields`) WHERE value = 'checklist');
