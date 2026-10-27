import { EventType, type RunAgentInput } from '@ag-ui/core';
import { AgentCapabilitiesSchema, EventSchemas } from '@ag-ui/core/schemas';
import { createMapContext } from '@pi-kit/pi-adapter';
import { firstValueFrom, toArray } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { createAskUserExtension } from '../pi/ask-user-extension';
import type { PiSessionService } from '../pi/pi-session.service';
import { UiBridge } from '../pi/ui-bridge';
import { PiAgent } from './pi-agent';

function world() {
  const ui = new UiBridge();
  const carry = new Map([['t', createMapContext({ threadId: 't', runId: 'old' })]]);
  const answerDialog = vi.fn((_thread: string, id: string, answer: Parameters<UiBridge['answer']>[1]) => ui.answer(id, answer));
  const answerAgentQuestion = vi.fn(async (id: string) => id.startsWith('agent-question:7:'));
  const sessions = { has: () => true, pendingDialogs: (_id: string, onlyNew?: boolean) => ui.list(onlyNew), markDialogsReported: (_id: string, ids: string[]) => ui.markReported(ids), answerDialog, answerAgentQuestion,
    subscribe: () => () => undefined, onUiEvent: () => () => undefined, onDialogRequested: (_id: string, fn: () => void) => ui.onDialog(fn), whenPromptDone: () => undefined, takeAbortedWhileWaiting: () => ui.takeAborted(), abort: vi.fn() } as unknown as PiSessionService;
  const agent = new PiAgent(sessions, { defaultCwd: '/work', threads: {} as never, carry, relayMcp: async () => undefined });
  const run = (resume: RunAgentInput['resume']) => firstValueFrom(agent.run({ threadId: 't', runId: 'new', messages: [], tools: [], context: [], state: {}, resume } as RunAgentInput).pipe(toArray()));
  return { ui, carry, answerDialog, answerAgentQuestion, agent, run };
}

describe('pi AG-UI interrupts', () => {
  it('advertises standard interrupt capability and resumes a model-callable question', async () => {
    const w = world();
    const capabilities = await w.agent.getCapabilities();
    expect(AgentCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(capabilities.humanInTheLoop?.interrupts).toBe(true);
    let tool!: ToolDefinition;
    createAskUserExtension()({ registerTool: (value: ToolDefinition) => { tool = value; } } as unknown as ExtensionAPI);
    const pending = tool.execute('question', { question: 'Which range?', options: ['Week', 'Month'] }, new AbortController().signal, undefined, { ui: w.ui } as never);
    const [dialog] = w.ui.list();
    const events = await w.run([{ interruptId: dialog.id, status: 'resolved', payload: 'Month' }]);
    expect(events.every((event) => EventSchemas.safeParse(event).success)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'success' } });
    expect(await pending).toMatchObject({ details: { value: 'Month', cancelled: false } });
  });

  it('hands the answer to a background agent\'s question to the agents and ends the run at once', async () => {
    const w = world();
    const events = await w.run([{ interruptId: 'agent-question:7:q1', status: 'resolved', payload: { value: 'Keep as is' } }]);
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
    expect(w.answerAgentQuestion).toHaveBeenCalledWith('agent-question:7:q1', { value: 'Keep as is' });
    expect(w.answerDialog).not.toHaveBeenCalled();
    await w.run([{ interruptId: 'agent-question:7:q2', status: 'cancelled' }]);
    expect(w.answerAgentQuestion).toHaveBeenLastCalledWith('agent-question:7:q2', 'cancelled');
    const unknown = await w.run([{ interruptId: 'agent-question:9:q1', status: 'resolved', payload: { value: 'x' } }]);
    expect(unknown.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'invalid_resume' });
    // While pi itself waits on a dialog, a refused answer leaves that dialog advertised.
    const waiting = w.ui.input('Name?');
    const [dialog] = w.ui.list(); w.ui.markReported([dialog.id]);
    const refused = await w.run([{ interruptId: 'agent-question:9:q1', status: 'resolved', payload: { value: 'x' } }]);
    expect(refused.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'interrupt', interrupts: [{ id: dialog.id }] } });
    w.ui.cancelAll(); await waiting;
  });

  it("keeps pi's own dialog and the context pi resumes from when a background agent's question is answered meanwhile", async () => {
    const w = world();
    const carried = w.carry.get('t');
    const waiting = w.ui.input('Name?');
    const [dialog] = w.ui.list(); w.ui.markReported([dialog.id]);
    const events = await w.run([{ interruptId: 'agent-question:7:q1', status: 'resolved', payload: { value: 'Keep as is' } }]);
    expect(w.answerAgentQuestion).toHaveBeenCalledWith('agent-question:7:q1', { value: 'Keep as is' });
    // The run ends suspended at pi's dialog, not as a success that would let the client forget it.
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'interrupt', interrupts: [{ id: dialog.id }] } });
    // The same map context is carried on, so pi's answer continues the assistant message it interrupted.
    expect(w.carry.get('t')).toBe(carried);
    expect(w.carry.get('t')?.runId).toBe('new');
    w.ui.cancelAll(); await waiting;
  });

  it('rejects an invalid batch atomically, says why and stays suspended at the same interrupt', async () => {
    const w = world();
    const first = w.ui.confirm('Continue?', 'yes/no');
    const second = w.ui.select('Range?', ['Week', 'Month']);
    const [a, b] = w.ui.list(); w.ui.markReported([a.id, b.id]);
    const events = await w.run([{ interruptId: a.id, status: 'resolved', payload: { confirmed: true } }, { interruptId: b.id, status: 'resolved', payload: { value: 'Year' } }]);
    expect(events.every((event) => EventSchemas.safeParse(event).success)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: EventType.CUSTOM, name: 'pi.notify', value: { level: 'error', text: 'Select an available option.' } }));
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'interrupt', interrupts: [{ id: a.id }, { id: b.id }] } });
    expect(w.answerDialog).not.toHaveBeenCalled();
    expect(w.ui.size).toBe(2); expect(w.carry.get('t')?.runId).toBe('new');
    w.ui.cancelAll(); await Promise.all([first, second]);
  });

  it('fails a malformed resume when no dialog is pending any more', async () => {
    const w = world();
    const events = await w.run([{ interruptId: 'gone', status: 'resolved', payload: { value: 'x' } }, { interruptId: 'gone', status: 'resolved', payload: { value: 'x' } }]);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'invalid_resume' });
    expect(events.some((event) => event.type === EventType.CUSTOM)).toBe(false);
  });

  it('reports the remaining interrupts after a partial resume and accepts cancellation', async () => {
    const w = world();
    const first = w.ui.input('Name?'); const second = w.ui.confirm('Proceed?', 'Details');
    const [a, b] = w.ui.list(); w.ui.markReported([a.id, b.id]);
    const events = await w.run([{ interruptId: a.id, status: 'resolved', payload: { value: 'Ada' } }]);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'interrupt', interrupts: [{ id: b.id }] } });
    expect(await first).toBe('Ada');
    const finished = await w.run([{ interruptId: b.id, status: 'cancelled' }]);
    expect(finished.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'success' } });
    expect(await second).toBe(false);
  });
});
