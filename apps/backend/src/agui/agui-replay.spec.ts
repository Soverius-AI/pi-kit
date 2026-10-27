import '../app/telemetry-off';
import { EventType } from '@ag-ui/client';
import { of } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { AguiService } from './agui.service';

it('forwards the replay cursor through the real CopilotKit SSE connect endpoint', async () => {
  const connect = vi.fn(() => of({ type: EventType.CUSTOM, name: 'pi.replay', value: { reset: false } }));
  const service = new AguiService({} as never, {} as never, { connect, useAgent: () => undefined } as never, {} as never, {} as never, { defaultCwd: '/tmp' } as never);
  const res = await service.handle(new Request('http://localhost/api/copilotkit/agent/pi/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pi-kit-replay-cursor': 'generation:42' },
    body: JSON.stringify({ threadId: 't1', runId: 'r1', messages: [], state: {}, tools: [], context: [], forwardedProps: {} }),
  }));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('pi.replay');
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1', headers: expect.objectContaining({ 'x-pi-kit-replay-cursor': 'generation:42' }) }));
});
