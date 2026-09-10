-- focus_key / focus_left_at (plan 13, TI-078): the order among the tasks on
-- the Focus desk (a fractional-indexing key, NULL outside the desk, unique
-- where present; focus = 1 exactly when focus_key IS NOT NULL) and the moment
-- a task last left the desk. Tasks already in focus get keys in
-- (area, status, order_key, id) order: 'a0' plus three base-62 digits of the
-- row number and a non-zero tail, valid fractional-indexing keys, so new
-- positions can be generated around them. Data rule (drizzle/v2/README.md,
-- variant b): admin.upgradeExport applies the same keys and NULL focus_left_at
-- to exports of formats 1-3.
ALTER TABLE `tasks` ADD `focus_key` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `focus_left_at` text;--> statement-breakpoint
WITH ranked AS (
  SELECT `id`, ROW_NUMBER() OVER (ORDER BY `area`, `status`, `order_key`, `id`) - 1 AS n
  FROM `tasks` WHERE `focus` = 1
)
UPDATE `tasks` SET `focus_key` = (
  SELECT 'a0'
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (n / 3844) % 62 + 1, 1)
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (n / 62) % 62 + 1, 1)
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', n % 62 + 1, 1)
    || 'V'
  FROM ranked WHERE ranked.`id` = `tasks`.`id`
) WHERE `focus` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_focus_key` ON `tasks` (`focus_key`) WHERE "tasks"."focus_key" IS NOT NULL;
