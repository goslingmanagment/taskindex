import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { clearDraft, readDraft, writeDraft, type Draft } from './drafts';
import { newIntent, nextIntent, type Intent, type IntentEvent } from './intent';
import { workspaceStore } from './store';
// TI-059 (план 07, шаг 9): семь мест писали черновик своим эффектом, поэтому
// правила «когда писать» и «когда стирать» расходились — пустые записи
// `title: ''` появлялись от одного открытия формы. Здесь одно правило: пишем,
// пока форма непустая (`enabled`), стираем, когда стала пустой; черновик от
// прежней версии базы не трогаем — владелец переносит из него текст руками.
type IntentHandle = {
  ref: RefObject<Intent>;
  /** Идентификатор создаваемой записи: он живёт ровно одно намерение. */
  entity: RefObject<string>;
  /** Переход по таблице состояний; возвращает новое намерение сразу. */
  dispatch: (event: IntentEvent) => Intent;
};
/**
 * TI-023: намерение живёт в ref, а не в состоянии: из него рисуется только
 * идентификатор операции, который форма кладёт в конверт при отправке.
 * Успех начинает новое намерение — с новой операцией и новой записью.
 */
export function useIntent(operationId: string, entityId: string): IntentHandle {
  const ref = useRef<Intent>(newIntent(operationId));
  const entity = useRef(entityId);
  const dispatch = useCallback((event: IntentEvent) => {
    ref.current = nextIntent(ref.current, event, () => crypto.randomUUID());
    if (event.type === 'success') entity.current = crypto.randomUUID();
    return ref.current;
  }, []);
  return { ref, entity, dispatch };
}
type DraftHandle<T> = IntentHandle & {
  /** Поколение базы на момент открытия формы. */
  generation: string;
  /** Черновик из хранилища; null, если его не было. */
  restored: Draft<T> | null;
  /** Черновик остался от прежней версии базы: показать, но не подставлять. */
  foreign: boolean;
  /** Поля восстановленного черновика этой версии базы. */
  fields: T | null;
  /** Идентификатор создаваемой записи, если форма его хранит. */
  entityId: string;
  /** Записать черновик вне эффекта — перед самой отправкой. */
  write: (fields: T) => void;
  clear: () => void;
};
export function useDraft<T>(
  key: string,
  fields: T,
  options: { enabled: boolean; baseRevision?: number; id?: string },
): DraftHandle<T> {
  const [generation] = useState(() => workspaceStore.getSnapshot().generation);
  const [restored] = useState(() => readDraft<T>(key));
  const foreign = restored !== null && restored.generation !== generation;
  const own = restored !== null && !foreign ? restored : null;
  // Форма может владеть идентификатором записи сама (диалог направления после
  // перехода на существующее); иначе он рождается здесь и переживает перезагрузку.
  const [initial] = useState(() => ({
    operationId: own?.operationId ?? crypto.randomUUID(),
    entityId: own?.id ?? crypto.randomUUID(),
  }));
  const intent = useIntent(initial.operationId, initial.entityId);
  const entityId = options.id ?? intent.entity.current;
  const baseRevision = options.baseRevision ?? 0;
  const write = (value: T) =>
    writeDraft<T>(key, {
      formatVersion: 1,
      generation,
      baseRevision,
      fields: value,
      id: entityId,
      operationId: intent.ref.current.operationId,
    });
  const clear = () => clearDraft(key);
  const enabled = options.enabled;
  // Поля приходят новым объектом на каждый рендер, поэтому эффект зависит от их
  // сериализации: запись идёт при изменении содержимого, а не на каждый рендер.
  const serialized = JSON.stringify(fields);
  useEffect(() => {
    if (!enabled) {
      if (!foreign) clearDraft(key);
      return;
    }
    writeDraft<T>(key, {
      formatVersion: 1,
      generation,
      baseRevision,
      fields: JSON.parse(serialized) as T,
      id: entityId,
      operationId: intent.ref.current.operationId,
    });
  }, [
    enabled,
    serialized,
    foreign,
    key,
    generation,
    baseRevision,
    entityId,
    intent.ref,
  ]);
  return {
    ...intent,
    generation,
    restored,
    foreign,
    fields: own?.fields ?? null,
    entityId,
    write,
    clear,
  };
}
