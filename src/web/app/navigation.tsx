import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import type { AreaId } from '@shared/model';
import { useSidebar } from '../ui/sidebar';
import { useLocationState, type LocationState } from './url';
import { effectiveProject } from './selectors';
import { useWorkspace } from './use-workspace';
// TI-059 (план 07, шаг 11): адрес экрана и переходы по нему — один контекст.
// Карточке, сайдбару и шапке больше не передают семь колбэков через пропсы.
type Navigation = {
  /** Адрес экрана; `project` уже проверен по существующим направлениям. */
  location: LocationState;
  update: (patch: Partial<LocationState>, replace?: boolean) => void;
  navigate: (area: AreaId, project?: string) => void;
  openTask: (id: string) => void;
  closeTask: () => void;
  showFocus: () => void;
  showActivity: () => void;
  showArchive: () => void;
  /** Тело доски: переход прокручивает его в начало. */
  bodyRef: RefObject<HTMLDivElement | null>;
};
const NavigationContext = createContext<Navigation | null>(null);
// A card opens a task but does not render the current URL. Keep that action
// independent of changes to search, view and the selected task (TI-085).
const OpenTaskContext = createContext<Navigation['openTask'] | null>(null);
export function useOpenTask(): Navigation['openTask'] {
  const open = useContext(OpenTaskContext);
  if (!open) throw new Error('NavigationProvider не найден.');
  return open;
}
export function useNavigation(): Navigation {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('NavigationProvider не найден.');
  return value;
}
export function NavigationProvider({ children }: { children: ReactNode }) {
  const [raw, setLocation] = useLocationState();
  const { loading, data } = useWorkspace();
  const { setOpenMobile } = useSidebar();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Пока пространство не загружено, направление из адреса не с чем сверять.
  const project = loading ? raw.project : effectiveProject(raw, data.projects);
  const location = useMemo(() => ({ ...raw, project }), [raw, project]);
  const update = useCallback(
    (patch: Partial<LocationState>, replace = false) =>
      // Несуществующее направление не переписывает URL из эффекта: оно просто
      // не выбрано, а из адреса уходит при первом же переходе.
      setLocation(
        patch.project === undefined && project !== raw.project
          ? { ...patch, project }
          : patch,
        replace,
      ),
    [setLocation, project, raw.project],
  );
  const openTask = useCallback((id: string) => update({ task: id }), [update]);
  const value = useMemo<Navigation>(() => {
    const closeNavigation = () => {
      setOpenMobile(false);
      bodyRef.current?.scrollTo({ left: 0, top: 0 });
    };
    return {
      location,
      update,
      bodyRef,
      navigate: (area: AreaId, nextProject = 'all') => {
        update({
          area,
          project: nextProject,
          q: '',
          focus: false,
          activity: false,
          actor: '',
          archive: false,
          today: false,
          task: '',
          contexts: false,
          status: '',
          parked: false,
        });
        closeNavigation();
      },
      openTask,
      closeTask: () => update({ task: '' }),
      showFocus: () => {
        update({
          focus: true,
          activity: false,
          actor: '',
          q: '',
          archive: false,
        });
        closeNavigation();
      },
      showActivity: () => {
        update({
          activity: true,
          focus: false,
          q: '',
          archive: false,
          contexts: false,
          status: '',
          parked: false,
        });
        closeNavigation();
      },
      showArchive: () => {
        update({
          archive: !location.archive,
          focus: false,
          activity: false,
          actor: '',
          q: '',
          today: false,
          project: 'all',
          contexts: false,
          status: '',
          parked: false,
        });
        closeNavigation();
      },
    };
  }, [location, update, openTask, setOpenMobile]);
  return (
    <NavigationContext value={value}>
      <OpenTaskContext value={openTask}>{children}</OpenTaskContext>
    </NavigationContext>
  );
}
