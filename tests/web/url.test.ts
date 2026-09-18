import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  defaultLocation,
  parseLocation,
  serializeLocation,
} from '../../src/web/app/url';

describe('TI-042 location is parsed from the URL only', () => {
  it('an empty search means the defaults, never the remembered location', () => {
    expect(parseLocation('')).toEqual(defaultLocation);
  });
  it.each([
    ['?area=agency&project=all&view=board', '/agency'],
    ['area=personal&project=all&view=board', '/personal'],
    [
      '?area=development&project=x&view=list',
      '/development/projects/x?view=list',
    ],
    [
      '?area=development&project=x&view=list&focus=1',
      '/focus?area=development&project=x&view=list',
    ],
    [
      '?area=personal&project=none&view=board&task=t1&q=%D0%BF%D0%BE%D0%B8%D1%81%D0%BA',
      '/personal/unassigned?task=t1&q=%D0%BF%D0%BE%D0%B8%D1%81%D0%BA',
    ],
    [
      '?area=agency&project=all&view=board&archive=1&archiveSearch=1',
      '/agency/archive?archiveSearch=1',
    ],
    [
      '?area=agency&project=content&archive=1',
      '/agency/projects/content/archive',
    ],
    [
      '?area=agency&project=all&view=board&today=1&activity=1',
      '/activity?today=1',
    ],
    ['?area=agency&project=all&view=list&done=1', '/agency?view=list&done=1'],
    [
      '?area=agency&project=all&view=board&activity=1&actor=agent%3Aworker',
      '/activity?actor=agent%3Aworker',
    ],
    [
      '?area=agency&project=all&view=board&focus=1&contexts=1&status=todo&parked=1',
      '/focus?contexts=1&status=todo&parked=1',
    ],
    ['?area=agency&project=archive&view=board', '/agency/projects/archive'],
  ])(
    'canonicalizes the legacy location %s to %s without losing state',
    (query, canonical) => {
      const state = parseLocation(query);
      expect(serializeLocation(state)).toBe(canonical);
      expect(parseLocation(canonical)).toEqual(state);
    },
  );
});

describe('Canonical location paths', () => {
  it('omits defaults and accepts trailing slashes', () => {
    expect(serializeLocation(defaultLocation)).toBe('/agency');
    expect(parseLocation('/development/')).toEqual({
      ...defaultLocation,
      area: 'development',
    });
    expect(
      serializeLocation(parseLocation('/agency/?view=board&today=0&unknown=x')),
    ).toBe('/agency');
  });
  it('keeps question marks within search text', () => {
    expect(parseLocation('/agency?q=why?now').q).toBe('why?now');
  });
  it('the route wins over conflicting legacy section parameters', () => {
    expect(
      parseLocation(
        '/personal?area=development&project=x&focus=1&activity=1&archive=1&done=1',
      ),
    ).toEqual({ ...defaultLocation, area: 'personal', done: true });
    expect(parseLocation('/focus?focus=0&activity=1&archive=1')).toEqual({
      ...defaultLocation,
      focus: true,
    });
  });
  it('handles encoded project segments and malformed URLs without crashing', () => {
    expect(parseLocation('/agency/projects/content%2Fideas').project).toBe(
      'content/ideas',
    );
    expect(
      serializeLocation(parseLocation('/agency/projects/content%2Fideas')),
    ).toBe('/agency/projects/content%2Fideas');
    expect(parseLocation('/agency/projects/%E0%A4%A')).toEqual(defaultLocation);
    expect(parseLocation('/unknown')).toEqual(defaultLocation);
  });
  it('round-trips screen context, filters and open tasks', () => {
    fc.assert(
      fc.property(
        fc.record({
          area: fc.constantFrom('agency', 'development', 'personal'),
          project: fc.constantFrom(
            'all',
            'none',
            'content',
            'archive',
            'project-42',
          ),
          view: fc.constantFrom('board', 'list'),
          task: fc.constantFrom('', 'task-1'),
          q: fc.string(),
          actor: fc.constantFrom('', 'agent:codex'),
          status: fc.constantFrom('', 'todo', 'doing'),
          today: fc.boolean(),
          done: fc.boolean(),
          archiveSearch: fc.boolean(),
          contexts: fc.boolean(),
          parked: fc.boolean(),
          screen: fc.constantFrom('board', 'focus', 'activity', 'archive'),
        }),
        ({ screen, ...values }) => {
          const state = {
            ...defaultLocation,
            ...values,
            focus: screen === 'focus',
            activity: screen === 'activity',
            archive: screen === 'archive',
          };
          const address = serializeLocation(state);
          expect(parseLocation(address)).toEqual(state);
          expect(serializeLocation(parseLocation(address))).toBe(address);
        },
      ),
    );
  });
  it('falls back to the agency board for unknown values', () => {
    expect(parseLocation('?area=nowhere&view=grid&focus=yes')).toEqual({
      ...defaultLocation,
      area: 'agency',
      view: 'board',
      focus: false,
    });
  });
});
