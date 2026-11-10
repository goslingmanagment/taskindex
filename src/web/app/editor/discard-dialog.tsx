import { Button } from '../../ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '../../ui/alert-dialog';
// Закрытие карточки с несохранёнными правками (план 07, шаг 13): сохранить,
// закрыть с черновиком, сбросить черновик или вернуться к правке.
export function DiscardDialog({
  open,
  onOpenChange,
  busy,
  error,
  canSave,
  canDiscard,
  onSave,
  onClose,
  onDiscard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  error: string;
  canSave: boolean;
  /** An unconfirmed save keeps its draft until its fate is known. */
  canDiscard: boolean;
  onSave: () => void;
  onClose: () => void;
  onDiscard: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Сохранить изменения?</AlertDialogTitle>
        <AlertDialogDescription>
          В карточке остались несохранённые правки.
        </AlertDialogDescription>
        {error && <p className="form-error">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Продолжить</AlertDialogCancel>
          {canDiscard && (
            <Button variant="destructive" disabled={busy} onClick={onDiscard}>
              Сбросить черновик
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Закрыть с черновиком
          </Button>
          <Button disabled={busy || !canSave} onClick={onSave}>
            Сохранить
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
// Сброс черновика из открытой карточки: правки пропадают, карточка
// показывает подтверждённую запись.
export function ResetDraftDialog({
  open,
  onOpenChange,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Сбросить черновик?</AlertDialogTitle>
        <AlertDialogDescription>
          Несохранённые правки пропадут, карточка покажет версию с сервера.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <Button variant="destructive" onClick={onReset}>
            Сбросить
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
