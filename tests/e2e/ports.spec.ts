import { test, expect } from '@playwright/test';
import {
  BASES,
  MAX_PORT_SLOT,
  PORT_SLOT_STEP,
  STATIC_PORT,
  portSlot,
} from './helpers';
// Port slots (TASKINDEX_E2E_SLOT): CI runners on one PC run e2e side by side,
// each in its own slot, so no two slots may share a port.
test('TASKINDEX_E2E_SLOT accepts only whole slots 0..MAX_PORT_SLOT', () => {
  expect(portSlot(undefined)).toBe(0);
  expect(portSlot('')).toBe(0);
  expect(portSlot(' 3 ')).toBe(3);
  expect(portSlot(String(MAX_PORT_SLOT))).toBe(MAX_PORT_SLOT);
  for (const raw of ['-1', '1.5', 'x', '0x2', String(MAX_PORT_SLOT + 1)])
    expect(() => portSlot(raw), raw).toThrow(/TASKINDEX_E2E_SLOT/);
});

test('one slot fits inside the slot step and the last slot stays below 10000', () => {
  const slot = portSlot(process.env.TASKINDEX_E2E_SLOT);
  const ports = [...BASES.flatMap((base) => [base.api, base.web]), STATIC_PORT];
  expect(new Set(ports).size).toBe(ports.length);
  // Slot 0 keeps the historical ports.
  expect(Math.min(...ports) - slot * PORT_SLOT_STEP).toBe(4001);
  expect(Math.max(...ports) - slot * PORT_SLOT_STEP).toBe(4373);
  // A span shorter than the step keeps every two slots disjoint.
  expect(Math.max(...ports) - Math.min(...ports)).toBeLessThan(PORT_SLOT_STEP);
  // 10000 and up is the CI PC's ephemeral range (outgoing connections).
  expect(
    Math.max(...ports) + (MAX_PORT_SLOT - slot) * PORT_SLOT_STEP,
  ).toBeLessThan(10000);
});
