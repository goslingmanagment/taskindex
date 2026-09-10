import type { DatabaseHandle } from './db.js';
import { getSetting, setSetting } from './db.js';
import { fail } from '../shared/errors.js';

export function openWrites(db: DatabaseHandle, deploymentId: string) {
  if (!deploymentId)
    fail('invalid', 'Для открытия записи нужен идентификатор деплоя.');
  setSetting(db, 'approved_deployment', deploymentId);
  return { writes: 'open' as const, deploymentId };
}
export function writesAreOpen(
  db: DatabaseHandle,
  mode: 'held' | 'open' = 'open',
  deploymentId?: string,
) {
  return (
    mode !== 'held' ||
    Boolean(
      deploymentId && getSetting(db, 'approved_deployment') === deploymentId,
    )
  );
}
