// The run report `last-run.json` (spec §5.2 stage 5): written by run.mts
// after every run, by run.sh when the runner crashed, read by morning.mts.
// Pure: types and the reading window.

const WINDOW_CAP_MS = 48 * 3_600_000;

export interface BoardStage {
  // Tasks on the board: every task of the snapshot outside the archive.
  tasks: number;
  drafts: number;
  created: number;
  existing: number;
  // Drafts not sent because the queue reached its cap of 15.
  skippedByCap: number;
}
export interface RunError {
  stage: string;
  message: string;
}
export interface RunReport {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  window: { from: string; to: string } | null;
  stages: { board?: BoardStage };
  errors: RunError[];
}

// The window of sources this run reads: from the start of the last good run
// to now. A failed run passes on the window it was given, so the run after
// a failure starts where the last good one did; the first run and a gap
// longer than two days read at most 48 hours.
export function runWindow(
  previous: RunReport | null,
  startedAt: Date,
): { from: string; to: string } {
  const floor = startedAt.getTime() - WINDOW_CAP_MS;
  const candidate = previous?.ok ? previous.startedAt : previous?.window?.from;
  const from = Math.min(
    startedAt.getTime(),
    Math.max(floor, candidate ? Date.parse(candidate) || 0 : 0),
  );
  return {
    from: new Date(from).toISOString(),
    to: startedAt.toISOString(),
  };
}
