import { describe, expect, it } from 'vitest';
import {
  defaultLocation,
  parseLocation,
  serializeLocation,
} from '../../src/web/app/url';

describe('TI-042 location is parsed from the URL only', () => {
  it('an empty search means the defaults, never the remembered location', () => {
    expect(parseLocation('')).toEqual(defaultLocation);
  });
  it('round-trips a full query without loss', () => {
    for (const query of [
      '?area=development&project=x&view=list&focus=1',
      '?area=personal&project=none&view=board&task=t1&q=%D0%BF%D0%BE%D0%B8%D1%81%D0%BA',
      '?area=agency&project=all&view=board&archive=1&archiveSearch=1',
      '?area=agency&project=all&view=board&today=1&activity=1',
      // TI-076: the author filter of the activity feed lives in the URL.
      '?area=agency&project=all&view=board&activity=1&actor=agent%3Aworker',
      // TI-078: the contexts drawer of the desk and its filters live in the URL
      // (`parked=1` stands for «not on the desk»: `focus=1` already names the
      // screen itself).
      '?area=agency&project=all&view=board&focus=1&contexts=1&status=todo&parked=1',
    ]) {
      const state = parseLocation(query);
      expect(serializeLocation(state)).toBe(query);
      expect(parseLocation(serializeLocation(state))).toEqual(state);
    }
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
