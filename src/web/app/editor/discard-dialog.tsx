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
// закрыть с черновиком или вернуться к правке.
export function DiscardDialog({
  open,
  onOpenChange,
  busy,
  error,
  canSave,
  onSave,
  onClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  error: string;
  canSave: boolean;
  onSave: () => void;
  onClose: () => void;
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
