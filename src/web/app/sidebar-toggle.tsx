import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { PanelLeft, PanelLeftClose } from 'lucide-react';
import { Button } from '../ui/button';
import { useSidebar } from '../ui/sidebar';
import { shortcutHint } from './sidebar-state';
// Скрытие панели навигации (2026-09-18). Кнопка «Скрыть панель» живёт в строке
// бренда внутри панели; когда панель скрыта, её место в шапке доски занимает
// «Открыть навигацию». Наведение на эту кнопку показывает панель поверх доски
// (peek): владелец переходит в другую область одним движением, не закрепляя
// панель; клик закрепляет. Фокус после переключения переезжает на парную
// кнопку, чтобы с клавиатуры панель открывалась и закрывалась одной клавишей.
// Задержки: peek не вспыхивает от случайного прохода указателя и не гаснет,
// пока указатель переходит с кнопки на панель.
const PEEK_DELAY_MS = 100;
const PEEK_LINGER_MS = 250;
// После переключения панели кнопка «Открыть навигацию» может появиться под
// покоящимся указателем: браузер шлёт ей pointerenter без движения мыши
// (⌘B, клавиатура), и предпросмотр открывался бы сам. Наведение в первые
// полсекунды после переключения не считается; движение мыши над кнопкой
// (pointermove) запускает предпросмотр, как только окно истекло.
const PEEK_SETTLE_MS = 500;
type SidebarPeek = {
  /** Панель показана поверх доски, пока указатель над кнопкой или над ней. */
  peek: boolean;
  peekStart: () => void;
  /** Спрятать после паузы; `true` — сразу (переход, закрепление). */
  peekEnd: (immediate?: boolean) => void;
  collapseRef: RefObject<HTMLButtonElement | null>;
  openRef: RefObject<HTMLButtonElement | null>;
};
const SidebarPeekContext = createContext<SidebarPeek | null>(null);
export function useSidebarPeek(): SidebarPeek {
  const value = useContext(SidebarPeekContext);
  if (!value) throw new Error('SidebarPeekProvider не найден.');
  return value;
}
// Состояние peek живёт у владельца панели (shell.tsx) рядом с `open`: любое
// закрепление или скрытие панели, включая ⌘B из примитива, гасит предпросмотр
// в том же обработчике, без эффекта поверх состояния.
export function SidebarPeekProvider({
  peek,
  onPeekChange,
  toggledAt,
  children,
}: {
  peek: boolean;
  onPeekChange: (peek: boolean) => void;
  /** `performance.now()` последнего закрепления или скрытия панели. */
  toggledAt: RefObject<number>;
  children: ReactNode;
}) {
  const timer = useRef<{
    id: ReturnType<typeof setTimeout>;
    next: boolean;
  } | null>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  // The same transition is never rescheduled: pointer moves over the button
  // keep one pending start instead of pushing it back with every move.
  const schedule = useCallback(
    (next: boolean, delay: number) => {
      if (timer.current?.next === next) return;
      if (timer.current) clearTimeout(timer.current.id);
      timer.current = {
        next,
        id: setTimeout(() => {
          timer.current = null;
          onPeekChange(next);
        }, delay),
      };
    },
    [onPeekChange],
  );
  const peekStart = useCallback(() => {
    if (performance.now() - toggledAt.current < PEEK_SETTLE_MS) return;
    schedule(true, PEEK_DELAY_MS);
  }, [schedule, toggledAt]);
  const peekEnd = useCallback(
    (immediate = false) => {
      if (!immediate) return schedule(false, PEEK_LINGER_MS);
      if (timer.current) clearTimeout(timer.current.id);
      timer.current = null;
      onPeekChange(false);
    },
    [schedule, onPeekChange],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current.id);
    },
    [],
  );
  const value = useMemo(
    () => ({ peek, peekStart, peekEnd, collapseRef, openRef }),
    [peek, peekStart, peekEnd],
  );
  return <SidebarPeekContext value={value}>{children}</SidebarPeekContext>;
}
const hint = () => shortcutHint('B', navigator.platform);
/** «Скрыть панель» в строке бренда; в мобильном листе закрывает лист. */
export function SidebarCollapseButton() {
  const { toggleSidebar, isMobile } = useSidebar();
  const { peekEnd, collapseRef, openRef } = useSidebarPeek();
  return (
    <Button
      ref={collapseRef}
      variant="ghost"
      size="icon-sm"
      className="sidebar-collapse"
      aria-label="Скрыть панель"
      title={isMobile ? undefined : `Скрыть панель · ${hint()}`}
      onClick={() => {
        peekEnd(true);
        toggleSidebar();
        requestAnimationFrame(() => openRef.current?.focus());
      }}
    >
      <PanelLeftClose />
    </Button>
  );
}
/** «Открыть навигацию» в шапке доски: только пока панель скрыта или на телефоне. */
export function SidebarOpenButton() {
  const { isMobile, state, open, openMobile, toggleSidebar } = useSidebar();
  const { peekStart, peekEnd, collapseRef, openRef } = useSidebarPeek();
  if (!isMobile && state === 'expanded') return null;
  return (
    <Button
      ref={openRef}
      variant="ghost"
      size="icon-sm"
      className="sidebar-open"
      aria-label="Открыть навигацию"
      aria-expanded={isMobile ? openMobile : open}
      onPointerEnter={(event) => {
        if (!isMobile && event.pointerType === 'mouse') peekStart();
      }}
      onPointerMove={(event) => {
        if (!isMobile && event.pointerType === 'mouse') peekStart();
      }}
      onPointerLeave={() => {
        if (!isMobile) peekEnd();
      }}
      onClick={() => {
        peekEnd(true);
        toggleSidebar();
        if (!isMobile)
          requestAnimationFrame(() => collapseRef.current?.focus());
      }}
    >
      <PanelLeft />
    </Button>
  );
}
