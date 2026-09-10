import { useEffect } from 'react';
// TI-059 (план 07, шаг 11): глобальные горячие клавиши доски. `blocked` — это
// «открыта карточка или диалог»: пока владелец в форме, ⌘K и N не работают.
export function useKeyboardShortcuts({
  blocked,
  onSearch,
  onCreate,
}: {
  blocked: boolean;
  onSearch: () => void;
  onCreate: (() => void) | null;
}) {
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement,
        typing =
          target.matches('input,textarea,select') || target.isContentEditable;
      if (blocked) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onSearch();
      } else if (
        !typing &&
        !e.metaKey &&
        !e.ctrlKey &&
        e.key.toLowerCase() === 'n' &&
        onCreate
      ) {
        e.preventDefault();
        onCreate();
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [blocked, onSearch, onCreate]);
}
