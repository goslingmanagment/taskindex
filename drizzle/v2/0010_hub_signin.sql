-- «Войти через хаб» (src/server/hub-signin.ts): a session opened from the
-- hub keeps the hub's grant to re-check that sign-in. A nullable column on
-- Better Auth's session table: existing password and passkey sessions stay
-- as they are (NULL). Auth tables are not exported, so the data rule
-- (TI-014) has nothing to replay and the export format is unchanged.
ALTER TABLE `session` ADD `hub_grant` text;