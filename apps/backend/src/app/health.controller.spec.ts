import { expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';

it('health is a synchronous in-memory read even while a database operation is waiting', () => {
  // A held DB operation must never become a prerequisite of liveness.
  const waiting = new Promise(() => undefined);
  const state = vi.fn(() => ({ enabled: true }));
  const controller = new HealthController({ state, waiting } as never);
  const health = controller.health();
  expect(health).not.toBeInstanceOf(Promise);
  expect(health).toMatchObject({ status: 'ok', pid: process.pid, backgroundAgents: { enabled: true } });
  expect(state).toHaveBeenCalledOnce();
});
