import { describe, expect, it } from 'vitest';
import { dateLabel } from '../../src/shared/queries';

describe('date labels', () => {
  it('keeps relative labels fresh when today changes', () => {
    expect(dateLabel(null, '2026-12-30')).toBe('');
    expect(dateLabel('2027-01-01', '2026-12-30')).toBe('1 янв');
    expect(dateLabel('2027-01-01', '2026-12-31')).toBe('Завтра');
    expect(dateLabel('2027-01-01', '2027-01-01')).toBe('Сегодня');
    expect(dateLabel('2027-01-01', '2027-01-02')).toBe('1 янв');
  });

  it('handles leap-day and month boundaries without changing UTC dates', () => {
    expect(dateLabel('2028-02-29', '2028-02-28')).toBe('Завтра');
    expect(dateLabel('2028-03-01', '2028-02-29')).toBe('Завтра');
    expect(dateLabel('2028-02-29', '2028-03-02')).toBe('29 февр');
  });
});
