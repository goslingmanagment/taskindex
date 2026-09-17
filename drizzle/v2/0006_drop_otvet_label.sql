-- Retire the label «ответ» (otvet): the owner dropped it on 2026-09-17, the
-- title already names who waits for an answer. Task rows lose the label and
-- keep the order of the rest; revision and updated_at stay, this is not an
-- event. Data rule (b): applyEvent drops labels outside the catalogue on
-- replay, so the journal replays to these rows; upgradeExport does the same
-- for format 5; stored operation results keep the label and taskSchema reads
-- it as a retired id.
UPDATE `tasks`
SET `labels` = (
  SELECT coalesce(json_group_array(`value` ORDER BY `key`), '[]')
  FROM json_each(`tasks`.`labels`)
  WHERE `value` <> 'otvet'
)
WHERE EXISTS (SELECT 1 FROM json_each(`tasks`.`labels`) WHERE `value` = 'otvet');
