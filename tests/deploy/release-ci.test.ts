import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Execute the real shell gate with fake external commands. No Git, network,
// SSH, Docker or credentials can be reached: PATH contains only the fixture.
function release(
  pushRun: string,
  pushState = 'completed/success',
  watch = '0',
) {
  const dir = mkdtempSync(join(tmpdir(), 'taskindex-release-ci-'));
  const log = join(dir, 'calls');
  const envFile = join(dir, 'commands.sh');
  writeFileSync(log, '');
  writeFileSync(
    envFile,
    `
git() {
  case "$1 $2" in
    'rev-parse --show-toplevel') printf '%s\\n' "$TEST_ROOT" ;;
    'rev-parse --verify') printf '%040d\\n' 1 ;;
    'fetch -q'|'merge-base --is-ancestor') ;;
    'log -1') printf 'fixture commit\\n' ;;
    *) return 90 ;;
  esac
}
gh() {
  case "$1 $2" in
    'run list')
      event=''
      while (( $# )); do
        if [[ $1 == --event ]]; then event=$2; shift; fi
        shift
      done
      if [[ $event == push ]]; then printf '%s' "$TEST_PUSH_RUN";
      else printf '99'; fi ;;
    'run view')
      if [[ $3 == 99 ]]; then printf 'completed/success';
      else printf '%s' "$TEST_PUSH_STATE"; fi ;;
    'run watch')
      printf 'watch %s %s\\n' "$3" "$4" >> "$TEST_LOG"
      [[ $4 == --exit-status ]] || return 93
      return "$TEST_WATCH" ;;
    *) return 91 ;;
  esac
}
ssh() { printf 'ssh\\n' >> "$TEST_LOG"; return 92; }
`,
  );
  try {
    const result = spawnSync('/bin/bash', [resolve('deploy/release.sh')], {
      env: {
        PATH: dir,
        BASH_ENV: envFile,
        TEST_ROOT: dir,
        TEST_LOG: log,
        TEST_PUSH_RUN: pushRun,
        TEST_PUSH_STATE: pushState,
        TEST_WATCH: watch,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    return { ...result, calls: readFileSync(log, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release CI proof', () => {
  it('rejects a successful draft-only run before any remote operation', () => {
    const result = release('');
    expect(result.status).not.toBe(0);
    expect(result.calls).toBe('');
    expect(result.stderr).toContain('push');
  });

  it('uses the push run even when a newer draft run is successful', () => {
    const result = release('77');
    expect(result.stderr).toContain('run 77 green');
    expect(result.calls).toBe('ssh\n');
  });

  it('does not substitute a successful draft run for a failing push run', () => {
    const result = release('77', 'completed/failure', '1');
    expect(result.status).not.toBe(0);
    expect(result.calls).toBe('watch 77 --exit-status\n');
    expect(result.stderr).toContain('not green');
  });

  it('awaits the selected push run before the first remote operation', () => {
    const result = release('77', 'in_progress/', '0');
    expect(result.calls).toBe('watch 77 --exit-status\nssh\n');
  });
});
