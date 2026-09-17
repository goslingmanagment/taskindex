import { describe, expect, it } from 'vitest';
import { directorySyncUnsupported } from '../../src/cli/outbox.js';

// Found on the owner's Windows PC 2026-09-18: fsync of the outbox directory
// answers EPERM there, and every write died after publishing its envelope.
describe('outbox on Windows', () => {
  it('tolerates the missing directory fsync only on win32 and only for EPERM', () => {
    const eperm = Object.assign(
      new Error('EPERM: operation not permitted, fsync'),
      {
        code: 'EPERM',
      },
    );
    expect(directorySyncUnsupported(eperm, 'win32')).toBe(true);
    expect(directorySyncUnsupported(eperm, 'darwin')).toBe(false);
    expect(directorySyncUnsupported(eperm, 'linux')).toBe(false);
    for (const code of ['EIO', 'EBADF', 'ENOSPC'])
      expect(
        directorySyncUnsupported(
          Object.assign(new Error(code), { code }),
          'win32',
        ),
      ).toBe(false);
    expect(directorySyncUnsupported(undefined, 'win32')).toBe(false);
    expect(directorySyncUnsupported(new Error('plain'), 'win32')).toBe(false);
  });
});
