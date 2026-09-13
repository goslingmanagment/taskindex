// TI-025, TI-026: the owner's appearance preference (mode and skin) lives on
// the server, travels through the ordinary command pipeline and is readable by
// the web (snapshot) and by the CLI (GET /api/appearance).
import { describe, it, expect, afterEach } from 'vitest';
import { fixture, success } from './helpers.js';
import { FORMAT_VERSION } from '../../src/shared/model.js';
import {
  exportWorkspace,
  importWorkspace,
  upgradeExport,
  validateExport,
} from '../../src/server/admin.js';
import { migrate, openDatabase, readState } from '../../src/server/db.js';
import { DEFAULT_APPEARANCE_ID, SKINS } from '../../src/shared/appearance.js';
import type { Appearance, Command, Snapshot } from '../../src/shared/model.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function api() {
  const f = fixture();
  cleanup.push(f.close);
  return f;
}

const read = async (f: ReturnType<typeof api>, role = 'owner') => {
  const response = await f.app.request('/api/appearance', {
    headers: { 'x-test-role': role },
  });
  return {
    status: response.status,
    body: (await response.json()) as Appearance,
  };
};

describe('appearance preference of the owner', () => {
  it('TI-086: the owner stores hideP3, an agent may not, and the flag alone is a valid update', async () => {
    const f = api();
    const set = success(
      await f.post({
        command: 'appearance.update',
        payload: { baseRevision: 1, hideP3: true },
      }),
    );
    expect(set.results[0]!.record).toMatchObject({ hideP3: true, revision: 2 });
    expect((await read(f)).body).toMatchObject({ hideP3: true });
    const agent = await f.post(
      {
        command: 'appearance.update',
        payload: { baseRevision: 2, hideP3: false },
      },
      { role: 'agent' },
    );
    expect(agent.status).toBe(403);
    const empty = await f.post({
      command: 'appearance.update',
      payload: { baseRevision: 2 },
    });
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ code: 'invalid' });
  });
  it('answers the default preference before anything was chosen', async () => {
    const f = api();
    const { status, body } = await read(f);
    expect(status).toBe(200);
    expect(body).toEqual({
      id: DEFAULT_APPEARANCE_ID,
      mode: 'system',
      skinId: 'classic',
      hideP3: false,
      revision: 1,
      updatedAt: null,
    });
  });

  it('lets the owner change mode and skin and reports the new revision', async () => {
    const f = api();
    const result = success(
      await f.post({
        command: 'appearance.update',
        payload: { baseRevision: 1, mode: 'dark', skinId: 'focus' },
      }),
    );
    expect(result.results[0]!.record).toMatchObject({
      id: DEFAULT_APPEARANCE_ID,
      mode: 'dark',
      skinId: 'focus',
      revision: 2,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.entityKind).toBe('appearance');
    expect(result.events[0]!.changes).toMatchObject({
      mode: { from: 'system', to: 'dark' },
      skinId: { from: 'classic', to: 'focus' },
    });
    expect((await read(f)).body).toMatchObject({
      mode: 'dark',
      skinId: 'focus',
    });
  });

  it('refuses an agent with 403 forbidden and keeps the preference', async () => {
    const f = api();
    const response = await f.post(
      {
        command: 'appearance.update',
        payload: { baseRevision: 1, mode: 'dark' },
      },
      { role: 'agent' },
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await read(f, 'agent')).body.mode).toBe('system');
  });

  it('rejects a stale baseRevision with conflict and an unknown skin with invalid', async () => {
    const f = api();
    success(
      await f.post({
        command: 'appearance.update',
        payload: { baseRevision: 1, mode: 'dark' },
      }),
    );
    const stale = await f.post({
      command: 'appearance.update',
      payload: { baseRevision: 1, mode: 'light' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ ok: false, code: 'conflict' });
    // An id outside the catalogue is refused by the payload schema, not
    // stored as a new skin (astra-26).
    const unknown = await f.post({
      command: 'appearance.update',
      payload: { baseRevision: 2, skinId: 'graphite' },
    } as unknown as Command);
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('carries the preference in the snapshot', async () => {
    const f = api();
    success(
      await f.post({
        command: 'appearance.update',
        payload: { baseRevision: 1, skinId: 'focus' },
      }),
    );
    const response = await f.app.request('/api/snapshot');
    const snapshot = (await response.json()) as Snapshot;
    expect(snapshot.appearance).toMatchObject({
      mode: 'system',
      skinId: 'focus',
      revision: 2,
    });
  });

  it('undo restores the previous preference without touching tasks', async () => {
    const f = api();
    success(
      await f.post({
        command: 'task.create',
        payload: { id: 't1', area: 'agency', title: 'Задача' },
      }),
    );
    const changed = success(
      await f.post(
        {
          command: 'appearance.update',
          payload: { baseRevision: 1, mode: 'dark', skinId: 'focus' },
        },
        { id: 'op-appearance' },
      ),
    );
    expect(changed.events[0]!.entityId).toBe(DEFAULT_APPEARANCE_ID);
    const undone = success(
      await f.post({
        command: 'undo',
        payload: { operationId: 'op-appearance' },
      }),
    );
    expect(undone.results[0]!.record).toMatchObject({
      mode: 'system',
      skinId: 'classic',
      hideP3: false,
      revision: 3,
    });
    expect((await read(f)).body).toMatchObject({
      mode: 'system',
      skinId: 'classic',
      hideP3: false,
    });
    expect(f.state().tasks[0]!.revision).toBe(1);
  });

  it('survives export, validation and import', () => {
    const f = api();
    const state = readState(f.db);
    expect(state.appearance).toHaveLength(1);
    const exported = exportWorkspace(f.db);
    expect(exported.appearance).toEqual(state.appearance);
    expect(() => validateExport(exported)).not.toThrow();
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, exported);
    expect(readState(target).appearance).toEqual(state.appearance);
  });

  it('gives an export of format 2 the default preference on import', () => {
    const f = api();
    const { appearance: _appearance, ...legacy } = exportWorkspace(f.db);
    const upgraded = upgradeExport({ ...legacy, formatVersion: 2 });
    expect(upgraded.formatVersion).toBe(FORMAT_VERSION);
    expect(upgraded.appearance).toEqual([
      {
        id: DEFAULT_APPEARANCE_ID,
        mode: 'system',
        skinId: 'classic',
        hideP3: false,
        revision: 1,
        updatedAt: null,
      },
    ]);
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, { ...legacy, formatVersion: 2 });
    expect(readState(target).appearance[0]).toMatchObject({
      mode: 'system',
      skinId: 'classic',
      hideP3: false,
    });
  });

  it('publishes the read route and the command in the OpenAPI document', async () => {
    const f = api();
    const response = await f.app.request('/api/openapi.json');
    const document = (await response.json()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.paths['/api/appearance']?.get?.operationId).toBe(
      'getAppearance',
    );
    expect(document.components.schemas.Appearance).toBeDefined();
    expect(JSON.stringify(document)).toContain('appearance.update');
  });

  it('offers both built-in skins with a preview palette', () => {
    expect(SKINS.map((skin) => skin.id)).toEqual(['classic', 'focus']);
    for (const skin of SKINS) {
      expect(skin.label.length).toBeGreaterThan(0);
      expect(
        Object.values(skin.preview).every((color) =>
          /^#[0-9a-f]{6}$/.test(color),
        ),
      ).toBe(true);
    }
  });
});
