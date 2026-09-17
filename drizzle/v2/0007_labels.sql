-- The owner's label catalogue as records (owner decision 2026-09-17): the
-- owner creates, renames and archives labels in the interface, agents read
-- them from /api/context. The five labels of the former code catalogue are
-- seeded with the same slugs, so task rows keep their labels untouched.
-- Data rule (b): validateExport replays the journal from these seeded records
-- (SEEDED_LABELS in src/shared/labels.ts, same values and timestamp), and
-- upgradeExport adds them to exports of formats 1-6.
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`color` text NOT NULL,
	`description` text NOT NULL,
	`position` integer NOT NULL,
	`archived_at` text,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_active_name` ON `labels` (`name_key`) WHERE archived_at IS NULL;
--> statement-breakpoint
INSERT INTO `labels` (`id`, `name`, `name_key`, `color`, `description`, `position`, `archived_at`, `revision`, `created_at`, `updated_at`) VALUES
('dengi', 'деньги', 'деньги', '#298467', 'Платёж, долг, приз, финансовое решение; при оплате строка в ledger', 1, NULL, 1, '2026-09-17T21:00:00.000Z', '2026-09-17T21:00:00.000Z'),
('5-min', '5 мин', '5 мин', '#8290a4', 'Делается за несколько минут, годится в просвет', 2, NULL, 1, '2026-09-17T21:00:00.000Z', '2026-09-17T21:00:00.000Z'),
('lora', 'Lora', 'lora', '#9661bf', 'Касается модели Lora', 3, NULL, 1, '2026-09-17T21:00:00.000Z', '2026-09-17T21:00:00.000Z'),
('lily', 'Lily', 'lily', '#397faf', 'Касается модели Lily', 4, NULL, 1, '2026-09-17T21:00:00.000Z', '2026-09-17T21:00:00.000Z'),
('ari', 'Ari', 'ari', '#a97928', 'Касается модели Ari', 5, NULL, 1, '2026-09-17T21:00:00.000Z', '2026-09-17T21:00:00.000Z');
