import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import type { DatabaseHandle } from './db.js';
import { withWrite, generation, migrate, schemaVersion } from './db.js';
import * as schema from './schema.js';
import { fail } from '../shared/errors.js';
import { z } from '../shared/schemas.js';

export function initialize(
  db: DatabaseHandle,
  options: { timezone?: string; migrationsDir?: string } = {},
) {
  migrate(db, options);
  return {
    generation: generation(db),
    schemaVersion: schemaVersion(options.migrationsDir),
  };
}
export async function createOwner(
  db: DatabaseHandle,
  input: { email: string; password: string; name?: string },
) {
  z.email().parse(input.email);
  z.string().min(8).max(128).parse(input.password);
  const password = await hashPassword(input.password);
  return withWrite(db, () => {
    if (db.orm.select().from(schema.user).get())
      fail('conflict', 'Владелец уже существует.');
    const now = new Date();
    const row = {
      id: 'owner',
      name: input.name ?? 'Владелец',
      email: input.email.toLowerCase(),
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    };
    db.orm.insert(schema.user).values(row).run();
    db.orm
      .insert(schema.account)
      .values({
        id: randomUUID(),
        accountId: 'owner',
        providerId: 'credential',
        userId: 'owner',
        password,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return { id: row.id, email: row.email, name: row.name };
  });
}
export async function resetOwnerPassword(
  db: DatabaseHandle,
  input: { password: string },
) {
  z.string().min(8).max(128).parse(input.password);
  const password = await hashPassword(input.password);
  return withWrite(db, () => {
    const owner = db.orm
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, 'owner'))
      .get();
    if (!owner) fail('not_found', 'Владелец не создан.');
    const account = db.orm
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, 'owner'))
      .all()
      .find((a) => a.providerId === 'credential');
    if (!account) fail('not_found', 'Пароль владельца не настроен.');
    db.orm
      .update(schema.account)
      .set({ password, updatedAt: new Date() })
      .where(eq(schema.account.id, account.id))
      .run();
    db.orm
      .delete(schema.session)
      .where(eq(schema.session.userId, 'owner'))
      .run();
    return { ok: true };
  });
}
