import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentQuery,
  FALLBACK_BREAKPOINT,
  isMobile,
  mobileQuery,
} from '../../src/web/hooks/use-mobile';

// TI-025: the hook must ask about the same threshold the skin uses. The stub
// understands only `(width < Nrem)`, which is exactly the shape the hook builds.
function stub(width: number, variable: string | null) {
  const asked: string[] = [];
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => {
      if (name !== '--breakpoint-md') throw new Error(`unexpected ${name}`);
      if (variable === null) throw new Error('no computed style');
      return variable;
    },
  }));
  vi.stubGlobal('window', {
    matchMedia: (query: string) => {
      asked.push(query);
      const rem = Number(/\(width < ([\d.]+)rem\)/.exec(query)?.[1]);
      return { matches: width < rem * 16 };
    },
  });
  return asked;
}
afterEach(() => vi.unstubAllGlobals());

describe('TI-025 the phone breakpoint comes from the theme', () => {
  it('builds the query from --breakpoint-md', () => {
    stub(400, ' 48rem ');
    expect(currentQuery()).toBe('(width < 48rem)');
  });
  it('falls back when the variable is missing or unreadable', () => {
    stub(400, '');
    expect(currentQuery()).toBe(mobileQuery(FALLBACK_BREAKPOINT));
    stub(400, null);
    expect(currentQuery()).toBe('(width < 48rem)');
  });
  it('is mobile at 767 and desktop at 768', () => {
    const asked = stub(767, '48rem');
    expect(isMobile()).toBe(true);
    expect(asked).toEqual(['(width < 48rem)']);
    stub(768, '48rem');
    expect(isMobile()).toBe(false);
  });
  it('follows a theme that moves the threshold', () => {
    stub(900, '60rem');
    expect(isMobile()).toBe(true);
    stub(1000, '60rem');
    expect(isMobile()).toBe(false);
  });
});
