import { Button } from '../ui/button';
import { toast } from '../ui/toast';
import { useWorkspace } from '../lib/use-workspace';
import { workspaceStore, STORAGE_UNAVAILABLE_MESSAGE } from './store';
// Status banners above the board: the storage degradation (TI-006) and
// operations whose outcome is unknown.
export function PendingNotice() {
  const { pending, generation, storageAvailable } = useWorkspace();
  return (
    <>
      {!storageAvailable && (
        <output className="pending-notice" data-notice="storage-unavailable">
          <span>{STORAGE_UNAVAILABLE_MESSAGE}</span>
        </output>
      )}
      {pending
        .filter((p) => p.status === 'unknown')
        .map((p) => (
          <output className="pending-notice" key={p.envelope.operationId}>
            <span>
              {p.envelope.generation === generation
                ? 'Изменение не подтверждено'
                : 'Изменение от прежней версии базы. Перенесите текст вручную.'}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={p.envelope.generation !== generation}
              onClick={() =>
                void workspaceStore
                  .retry(p.envelope.operationId)
                  .catch((e) => toast.add({ title: e.message, type: 'error' }))
              }
            >
              Повторить
            </Button>
          </output>
        ))}
    </>
  );
}
