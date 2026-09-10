import React from 'react';
import { createRoot } from 'react-dom/client';
import { Workspace } from './components/workspace';
import { makeSeed } from './lib/workspace';
import './app/globals.css';
const NativeDate = Date;
const fixed = NativeDate.parse('2026-09-08T09:00:00Z');
window.Date = class extends NativeDate {
  constructor(...args: any[]) {
    if (args.length) super(...(args as [any]));
    else super(fixed);
  }
  static now() {
    return fixed;
  }
} as DateConstructor;
let fixture = makeSeed('2026-09-07');
fixture.tasks.find((t) => t.id === 'a1')!.focus = true;
fixture.tasks.push({
  ...fixture.tasks.find((t) => t.id === 'a9')!,
  id: 'reference-archive',
  title: 'Архив: согласовать прошлую неделю',
  archived: true,
});
window.fetch = async (input, init) => {
  const path =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.pathname
        : input.url;
  if (path !== '/api/workspace')
    throw new Error('Reference harness rejects non-fixture fetch: ' + path);
  if (!init?.method || init.method === 'GET')
    return Response.json({ ...fixture, initialized: true });
  const { action, value } = JSON.parse(String(init.body || '{}'));
  if (action === 'initialize')
    throw new Error('Reference fixture is already initialized');
  if (action === 'task' || action === 'project') {
    const key = action === 'task' ? 'tasks' : 'projects';
    const list = fixture[key] as any[];
    const next = { ...value, revision: (value.revision || 0) + 1 };
    const index = list.findIndex((t) => t.id === next.id);
    if (index < 0) list.push(next);
    else list[index] = next;
    return Response.json({ value: next });
  }
  return Response.json(
    { error: 'Unsupported fixture action' },
    { status: 400 },
  );
};
createRoot(document.getElementById('root')!).render(<Workspace />);
