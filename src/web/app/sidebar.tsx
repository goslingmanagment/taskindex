import {
  BriefcaseBusiness,
  Code2,
  House,
  Plus,
  LayoutGrid,
  Archive,
  LockKeyhole,
  PanelsTopLeft,
  Star,
  History,
} from 'lucide-react';
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '../ui/sidebar';
import { Button } from '../ui/button';
import { AREAS, type AreaId, type Project, type Task } from '../lib/workspace';
import type { LocationState } from './url';
import { AccountMenu } from './auth';
import { taskCount } from './labels';
const icons = {
  agency: BriefcaseBusiness,
  development: Code2,
  personal: House,
};
export function WorkspaceSidebar({
  location,
  projects,
  tasks,
  focusCount,
  navigate,
  showFocus,
  showActivity,
  showArchive,
  createProject,
  disabled,
}: {
  location: LocationState;
  projects: Project[];
  tasks: Task[];
  focusCount: number;
  navigate: (area: AreaId, project?: string) => void;
  showFocus: () => void;
  showActivity: () => void;
  showArchive: () => void;
  createProject: () => void;
  disabled: boolean;
}) {
  const { area, project: projectId, archive, focus, activity, q } = location,
    globalView = !!q.trim() || focus || activity,
    archivedCount = tasks.filter((t) => t.area === area && t.archived).length;
  return (
    <Sidebar className="workspace-sidebar">
      <SidebarHeader className="brand">
        <span className="brand-symbol">
          <PanelsTopLeft size={22} />
        </span>
        <span>TaskIndex</span>
      </SidebarHeader>
      <SidebarContent className="side-body">
        <SidebarMenu className="area-nav">
          <SidebarMenuItem>
            <SidebarMenuButton
              className="area-button"
              isActive={focus && !q}
              onClick={showFocus}
            >
              <span className="area-icon">
                <Star size={18} />
              </span>
              <span>Фокус</span>
              <span className="focus-count" aria-hidden="true">
                {focusCount || ''}
              </span>
              {focusCount > 0 && (
                <span className="sr-only">{taskCount(focusCount)}</span>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="area-button"
              isActive={activity && !q}
              onClick={showActivity}
            >
              <span className="area-icon">
                <History size={18} />
              </span>
              <span>Активность</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {AREAS.map((a) => {
            const Icon = icons[a.id];
            return (
              <SidebarMenuItem key={a.id}>
                <SidebarMenuButton
                  className="area-button"
                  isActive={a.id === area && !globalView}
                  onClick={() => navigate(a.id)}
                >
                  <span className="area-icon">
                    <Icon size={18} />
                  </span>
                  <span>{a.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
        <div className="nav-section-heading">
          <span>{area === 'development' ? 'Проекты' : 'Направления'}</span>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="project-button"
              isActive={projectId === 'all' && !archive && !globalView}
              onClick={() => navigate(area)}
            >
              <LayoutGrid />
              <span>Все задачи</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {projects.map((project) => (
            <SidebarMenuItem key={project.id}>
              <SidebarMenuButton
                className="project-button"
                isActive={projectId === project.id && !archive && !globalView}
                onClick={() => navigate(area, project.id)}
              >
                <span
                  className="project-dot"
                  style={{ background: project.color }}
                />
                <span>{project.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {tasks.some((t) => t.area === area && !t.projectId && !t.archived) &&
            projects.length > 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="project-button"
                  isActive={projectId === 'none' && !archive && !globalView}
                  onClick={() => navigate(area, 'none')}
                >
                  <span className="project-dot unassigned-dot" />
                  <span>Без направления</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
        </SidebarMenu>
        <Button
          variant="ghost"
          className="add-project"
          disabled={disabled}
          onClick={createProject}
        >
          <Plus />
          Добавить {area === 'development' ? 'проект' : 'направление'}
        </Button>
      </SidebarContent>
      <SidebarFooter className="side-footer">
        <Button
          variant="ghost"
          className={'archive-link ' + (archive ? 'active' : '')}
          onClick={showArchive}
        >
          <Archive size={15} />
          Архив
          <span aria-hidden="true">{archivedCount || ''}</span>
          {archivedCount > 0 && (
            <span className="sr-only">{taskCount(archivedCount)}</span>
          )}
        </Button>
        <div className="private-note">
          <AccountMenu />
          <LockKeyhole size={13} />
          <span>Приватно</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
