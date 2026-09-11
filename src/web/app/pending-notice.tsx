// oxlint-disable jsx-a11y/prefer-tag-over-role -- план 07, §3.9: `<output>` это
// результат вычисления и по HTML принимает только фразовое содержимое, а здесь
// внутри живут абзацы, `pre` и кнопки. Роль `status` даёт ту же живую область
// без нарушения модели содержимого.
import { Button } from '../ui/button';
import { toast } from '../ui/toast';
import { useWorkspace } from './use-workspace';
import {
  workspaceStore,
  SERVER_UPDATED_MESSAGE,
  STORAGE_UNAVAILABLE_MESSAGE,
} from './store';
import { describeEnvelope } from './pending';
// Status banners above the board: the storage degradation (TI-006) and
// operations whose outcome is unknown (TI-038: text visible, explicit removal).
export function PendingNotice() {
  const { pending, generation, storageAvailable, incompatible } =
    useWorkspace();
  return (
    <>
      {incompatible && (
        <section
          className="pending-notice"
          role="status"
          aria-live="polite"
          data-notice="server-updated"
        >
          <span>{SERVER_UPDATED_MESSAGE}</span>
          <div className="pending-notice-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => location.reload()}
            >
              Перезагрузить
            </Button>
          </div>
        </section>
      )}
      {!storageAvailable && (
        <section
          className="pending-notice"
          role="status"
          aria-live="polite"
          data-notice="storage-unavailable"
        >
          <span>{STORAGE_UNAVAILABLE_MESSAGE}</span>
        </section>
      )}
      {pending
        .filter((p) => p.status === 'unknown')
        .map((p) => {
          const own = p.envelope.generation === generation;
          const { title, texts } = describeEnvelope(p.envelope);
          return (
            <section
              className="pending-notice"
              role="status"
              aria-live="polite"
              key={p.envelope.operationId}
              data-notice={own ? 'unknown' : 'foreign-generation'}
            >
              <div className="pending-notice-body">
                <span>
                  {p.message ?? 'Изменение не подтверждено'}
                  {!own && '. Перенесите текст вручную.'}
                </span>
                <small>{title}</small>
                {texts.length > 0 && <pre>{texts.join('\n')}</pre>}
              </div>
              <div className="pending-notice-actions">
                {own && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void workspaceStore
                        .retry(p.envelope.operationId)
                        .catch((error: Error) =>
                          toast.add({ title: error.message, type: 'error' }),
                        )
                    }
                  >
                    Повторить
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Убрать: ${title}`}
                  onClick={() => workspaceStore.dismiss(p.envelope.operationId)}
                >
                  Убрать
                </Button>
              </div>
            </section>
          );
        })}
    </>
  );
}
