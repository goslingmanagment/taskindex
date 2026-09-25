#!/usr/bin/env node
// Ночная смена, фаза 1: проверка доски без нейросети и отчёт прогона
// (спека 2026-09-25-agent-proposals §5.2, этапы 3 и 5). Запускается из
// run.sh; сам по себе тоже работает:
//
//   node scripts/night-shift/run.mts
//
// Код выхода: 0 — прогон без ошибок, 3 — отчёт записан с ok: false, любой
// другой — падение до записи отчёта (его пишет run.sh).
import type { DomainEvent, Snapshot } from '../../src/shared/model.ts';
import { auditBoard, collectLastEvents, DEFAULT_TIMEZONE } from './audit.mts';
import {
  ensureStateDir,
  errorMessage,
  readReport,
  reportPath,
  taskindex,
  writeReport,
} from './io.mts';
import { runWindow, type BoardStage, type RunReport } from './report.mts';

// The queue cap of spec §5.2: a week without answers is not a pile.
const QUEUE_CAP = 15;

if (process.argv.includes('--help')) {
  process.stdout.write(
    'node scripts/night-shift/run.mts: проверка доски, предложения в очередь, отчёт last-run.json\n',
  );
  process.exit(0);
}

async function queuedCount(): Promise<number> {
  const pages = await taskindex(['proposals', '--status', 'queued', '--all']);
  return pages.reduce(
    (total, page) =>
      total + (Array.isArray(page.items) ? page.items.length : 0),
    0,
  );
}

// `proposal.create` answers with the operation; the first command result
// says whether the fingerprint was already known (plan §1.2).
function isExisting(reply: Record<string, unknown>): boolean {
  const results = Array.isArray(reply.results) ? reply.results : [];
  const first = results[0] as Record<string, unknown> | undefined;
  return first?.existing === true || reply.existing === true;
}

async function boardStage(stats: BoardStage): Promise<void> {
  const [snapshot] = (await taskindex(['snapshot'])) as unknown as [Snapshot];
  if (!snapshot || !Array.isArray(snapshot.tasks))
    throw new Error('taskindex snapshot: ответ без задач');
  stats.tasks = snapshot.tasks.filter((task) => !task.archived).length;
  const pages = await taskindex(['events', '--all']);
  const events: DomainEvent[] = [];
  for (const page of pages) {
    if (page.generation !== snapshot.generation)
      throw new Error(
        'поколение базы сменилось между снимком и журналом, проверка отложена',
      );
    if (Array.isArray(page.events))
      events.push(...(page.events as DomainEvent[]));
  }
  const drafts = auditBoard({
    tasks: snapshot.tasks,
    lastEventAt: collectLastEvents({
      tasks: snapshot.tasks,
      steps: snapshot.steps,
      events,
    }),
    today: snapshot.today,
    timezone: snapshot.timezone || DEFAULT_TIMEZONE,
  });
  stats.drafts = drafts.length;
  let queued = await queuedCount();
  for (const [index, draft] of drafts.entries()) {
    if (queued >= QUEUE_CAP) {
      stats.skippedByCap = drafts.length - index;
      break;
    }
    const [reply] = await taskindex([
      'proposal',
      'create',
      '--payload',
      JSON.stringify(draft),
    ]);
    if (reply && isExisting(reply)) stats.existing += 1;
    else {
      stats.created += 1;
      queued += 1;
    }
  }
}

const startedAt = new Date();
const dir = await ensureStateDir();
const file = reportPath(dir);
const report: RunReport = {
  startedAt: startedAt.toISOString(),
  finishedAt: '',
  ok: false,
  window: runWindow(await readReport(file), startedAt),
  stages: {},
  errors: [],
};
const board: BoardStage = {
  tasks: 0,
  drafts: 0,
  created: 0,
  existing: 0,
  skippedByCap: 0,
};
report.stages.board = board;
try {
  await boardStage(board);
} catch (error) {
  report.errors.push({ stage: 'board', message: errorMessage(error) });
}
report.finishedAt = new Date().toISOString();
report.ok = report.errors.length === 0;
await writeReport(report, file);
process.stdout.write(
  `${JSON.stringify({ ok: report.ok, board, errors: report.errors })}\n`,
);
process.exitCode = report.ok ? 0 : 3;
