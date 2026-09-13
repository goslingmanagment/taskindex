-- Priority, labels, closes and hide_p3 (TI-086, owner-workflow specification §4).
-- Existing rows get p2, no labels, no problem and visible P3. Data rule (b):
-- applyEvent supplies the same task defaults for old creation events;
-- defaultAppearance and backup.upgradeExport preserve old appearance history.
ALTER TABLE `appearance` ADD `hide_p3` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority` text DEFAULT 'p2' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `labels` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `closes` text;
