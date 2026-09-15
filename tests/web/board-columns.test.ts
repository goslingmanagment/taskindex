import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, shownColumns } from '../../src/web/app/board-columns';
import { defaultLocation, parseLocation } from '../../src/web/app/url';

describe('the «Готово» column is hidden by default', () => {
  it('a bare address keeps the column off', () => {
    expect(defaultLocation.done).toBe(false);
    expect(parseLocation('?area=agency&view=board').done).toBe(false);
  });
  it('lists four working columns without it and all five with it', () => {
    expect(shownColumns(false).map((c) => c.id)).toEqual([
      'doing',
      'p1',
      'p2',
      'p3',
    ]);
    expect(shownColumns(true)).toBe(BOARD_COLUMNS);
  });
});
