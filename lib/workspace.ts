export const AREAS = [
  {
    id: 'agency',
    name: 'Агентство',
    color: '#3763df',
    description: 'Команда и ежедневная работа',
  },
  {
    id: 'development',
    name: 'Разработка',
    color: '#7855c7',
    description: 'Продукты и инструменты',
  },
  {
    id: 'personal',
    name: 'Личное',
    color: '#248168',
    description: 'Время для своих дел',
  },
] as const;
export type AreaId = (typeof AREAS)[number]['id'];
export const STATUSES = [
  { id: 'todo', name: 'Очередь', hint: 'Следующее — сверху', color: '#8290a4' },
  {
    id: 'doing',
    name: 'В работе',
    hint: 'То, чем занимаешься сейчас',
    color: '#416ae3',
  },
  {
    id: 'waiting',
    name: 'Жду',
    hint: 'Мяч на другой стороне',
    color: '#bd811d',
  },
  { id: 'done', name: 'Готово', hint: 'Можно выдохнуть', color: '#298467' },
] as const;
export type Status = (typeof STATUSES)[number]['id'];
export type Project = {
  id: string;
  area: AreaId;
  name: string;
  color: string;
  revision: number;
};
export type Task = {
  id: string;
  area: AreaId;
  projectId: string;
  title: string;
  status: Status;
  note: string;
  due: string;
  waitingFor: string;
  followUp: string;
  checklist: { id: string; text: string; done: boolean }[];
  rank: number;
  demo: boolean;
  archived: boolean;
  focus?: boolean;
  revision: number;
};
export type WorkspaceData = { projects: Project[]; tasks: Task[] };
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function makeSeed(base = '2026-09-07'): WorkspaceData {
  const projects: Project[] = [
    ['hiring', 'agency', 'Найм', '#9661bf'],
    ['content', 'agency', 'Контент', '#397faf'],
    ['team', 'agency', 'Чаттеры', '#a97928'],
    ['traffic', 'agency', 'Трафик', '#39816d'],
    ['operations', 'agency', 'Организационное', '#737c92'],
    ['hub', 'development', 'Hub', '#527ee0'],
    ['chatgoose', 'development', 'ChatGoose', '#9570c8'],
    ['contentops', 'development', 'ContentOps', '#258c8c'],
    ['telegram', 'development', 'tg-assistant', '#5e88ad'],
    ['psyflow', 'development', 'psyflow', '#b4779b'],
  ].map(([id, area, name, color]) => ({
    id,
    area: area as AreaId,
    name,
    color,
    revision: 1,
  }));
  const date = (offset: number) => {
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + offset);
    return localDate(d);
  };
  const rows: [string, AreaId, string, Status, string, Partial<Task>?][] = [
    [
      'a1',
      'agency',
      'hiring',
      'todo',
      'Выбрать контент-менеджера',
      {
        note: 'Начать с короткого списка. Сравнить опыт и доступность.',
        checklist: [
          { id: 'ac1', text: 'Собрать короткий список', done: true },
          { id: 'ac2', text: 'Посмотреть тестовые', done: false },
          { id: 'ac3', text: 'Выбрать, с кем созвониться', done: false },
        ],
      },
    ],
    [
      'a2',
      'agency',
      'content',
      'todo',
      'Собрать контент-план на неделю',
      { due: date(1), note: 'Оставить место для правок и новых материалов.' },
    ],
    [
      'a3',
      'agency',
      'traffic',
      'todo',
      'Выбрать один канал для следующего теста',
    ],
    [
      'a4',
      'agency',
      'operations',
      'todo',
      'Упростить еженедельную сверку задач',
    ],
    [
      'a5',
      'agency',
      'content',
      'doing',
      'Согласовать структуру контент-папок',
      {
        checklist: [
          { id: 'ac4', text: 'Описать названия папок', done: true },
          { id: 'ac5', text: 'Проверить на одном наборе', done: false },
        ],
        note: 'Проверить, что нужный материал легко найти без подсказок.',
      },
    ],
    [
      'a6',
      'agency',
      'hiring',
      'doing',
      'Подготовить короткое тестовое',
      { due: date(2) },
    ],
    [
      'a7',
      'agency',
      'team',
      'waiting',
      'Согласовать график команды',
      { waitingFor: 'Подтверждение команды', followUp: date(1) },
    ],
    [
      'a8',
      'agency',
      'content',
      'waiting',
      'Получить правки к контент-плану',
      { waitingFor: 'Ответ контент-менеджера', followUp: date(3) },
    ],
    [
      'a9',
      'agency',
      'operations',
      'done',
      'Собрать рабочие ссылки в одном месте',
    ],
    [
      'd1',
      'development',
      'contentops',
      'todo',
      'Выбрать первый сценарий ContentOps',
      { note: 'Один полный путь: материал появился → его легко найти.' },
    ],
    [
      'd2',
      'development',
      'hub',
      'doing',
      'Проверить путь новой сессии',
      {
        checklist: [
          { id: 'dc1', text: 'Описать ожидаемое поведение', done: true },
          { id: 'dc2', text: 'Пройти сценарий целиком', done: false },
        ],
      },
    ],
    [
      'd3',
      'development',
      'chatgoose',
      'todo',
      'Собрать замечания по интерфейсу',
    ],
    [
      'd4',
      'development',
      'telegram',
      'waiting',
      'Согласовать следующий сценарий найма',
      { waitingFor: 'Решение по процессу' },
    ],
    ['d5', 'development', 'psyflow', 'todo', 'Упростить первый экран'],
    [
      'd6',
      'development',
      'contentops',
      'doing',
      'Разобрать требования к поиску',
    ],
    ['d7', 'development', 'hub', 'done', 'Зафиксировать критерии проверки'],
    ['p1', 'personal', '', 'todo', 'Спланировать свободный вечер'],
    ['p2', 'personal', '', 'todo', 'Разобрать папку загрузок'],
    ['p3', 'personal', '', 'doing', 'Выбрать книгу на вечер'],
  ];
  return {
    projects,
    tasks: rows.map(([id, area, projectId, status, title, extra], rank) => ({
      id,
      area,
      projectId,
      status,
      title,
      note: '',
      due: '',
      waitingFor: '',
      followUp: '',
      checklist: [],
      rank: rank * 1024,
      demo: true,
      archived: false,
      revision: 1,
      ...extra,
    })),
  };
}
export function dateLabel(value: string, today: string): string {
  if (!value) return '';
  if (value === today) return 'Сегодня';
  const d = new Date(today + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  if (value === localDate(d)) return 'Завтра';
  return new Date(value + 'T12:00:00')
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
    .replace('.', '');
}
