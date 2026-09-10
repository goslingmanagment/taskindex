// Plan 10, §3.5: a swallowed rejection must still say why it is swallowed.
import { it, expect, vi } from 'vitest';
import { ignoreRejection } from '../../src/shared/ignore-rejection.js';

it('swallows the rejection and names the reason in development', async () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const failure = new Error('boom');
  ignoreRejection(Promise.reject(failure), 'ошибка refresh уже в state.error');
  ignoreRejection(Promise.resolve('ok'), 'не должно ничего печатать');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dev = Boolean(import.meta.env?.DEV);
  expect(debug.mock.calls).toEqual(
    dev
      ? [['ignored rejection', 'ошибка refresh уже в state.error', failure]]
      : [],
  );
  debug.mockRestore();
});
