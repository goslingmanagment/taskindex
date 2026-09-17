import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_STORAGE_KEY,
  readSidebarOpen,
  shortcutHint,
  writeSidebarOpen,
} from '../../src/web/app/sidebar-state';

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}
const refusing = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

describe('the navigation panel remembers whether it is hidden on this device', () => {
  it('is open without a stored choice and hidden only for «collapsed»', () => {
    expect(readSidebarOpen(undefined)).toBe(true);
    expect(readSidebarOpen(memory())).toBe(true);
    expect(
      readSidebarOpen(memory({ [SIDEBAR_STORAGE_KEY]: 'collapsed' })),
    ).toBe(false);
    expect(readSidebarOpen(memory({ [SIDEBAR_STORAGE_KEY]: 'иное' }))).toBe(
      true,
    );
  });
  it('stores only the hidden state and clears it when the panel returns', () => {
    const storage = memory();
    writeSidebarOpen(storage, false);
    expect(storage.map.get(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
    writeSidebarOpen(storage, true);
    expect(storage.map.has(SIDEBAR_STORAGE_KEY)).toBe(false);
  });
  it('treats a refusing storage as «open» and never throws', () => {
    expect(readSidebarOpen(refusing)).toBe(true);
    expect(() => writeSidebarOpen(refusing, false)).not.toThrow();
    expect(() => writeSidebarOpen(undefined, false)).not.toThrow();
  });
  it('names the shortcut for the platform', () => {
    expect(shortcutHint('B', 'MacIntel')).toBe('⌘B');
    expect(shortcutHint('B', 'iPad')).toBe('⌘B');
    expect(shortcutHint('B', 'Win32')).toBe('Ctrl+B');
    expect(shortcutHint('B', 'Linux x86_64')).toBe('Ctrl+B');
  });
});
