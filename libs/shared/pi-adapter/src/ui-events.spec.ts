import { EventType } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { parsePiCustomEvent } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { interruptFinished, mapUiEvent } from './ui-events';

describe('mapUiEvent', () => {
  it('maps notify, setStatus and setTitle to valid pi.* custom events', () => {
    const events = [
      ...mapUiEvent({ kind: 'notify', message: 'blocked', level: 'warning' }),
      ...mapUiEvent({ kind: 'notify', message: 'hi' }),
      ...mapUiEvent({ kind: 'status', key: 'git', text: '3 staged' }),
      ...mapUiEvent({ kind: 'status', key: 'git', text: undefined }),
      ...mapUiEvent({ kind: 'title', title: 'pi - kit' }),
    ];
    const parsed = events.map((e) => parsePiCustomEvent(e as unknown as { name: string; value: unknown }));
    expect(parsed.every(Boolean)).toBe(true);
    expect(parsed.map((p) => p?.value)).toEqual([
      { level: 'warning', text: 'blocked' },
      { level: 'info', text: 'hi' },
      { key: 'git', text: '3 staged' },
      { key: 'git', text: '' },
      { title: 'pi - kit' },
    ]);
  });

  it('maps a toolbar registration to a pi.composer custom event that carries it as it is', () => {
    const registrations = [
      { op: 'action', id: 'pk-hello', label: 'Say hello', icon: 'Hi', text: '/pk-fruit ' },
      { op: 'suggestion', id: 'pk-suggest', title: 'Ask for a fruit', text: '/pk-fruit apple', send: false },
      { op: 'remove', id: 'pk-hello' },
    ] as const;
    const events = registrations.flatMap((registration) => mapUiEvent({ kind: 'composer', registration }));
    expect(events.map((e) => parsePiCustomEvent(e as unknown as { name: string; value: unknown }))).toEqual(
      registrations.map((value) => ({ name: 'pi.composer', value })),
    );
    expect(events.every((e) => EventSchemas.safeParse(e).success)).toBe(true);
  });

  it('maps setWidget to a pi.widget activity, and a cleared widget to an empty one', () => {
    const [shown] = mapUiEvent({ kind: 'widget', key: 'todo', lines: ['a', 'b'], placement: 'belowEditor' });
    expect(shown).toMatchObject({ messageId: 'widget:todo', activityType: 'pi.widget', content: { key: 'todo', lines: ['a', 'b'], placement: 'belowEditor' } });
    expect(mapUiEvent({ kind: 'widget', key: 'todo', lines: undefined })[0]).toMatchObject({ content: { lines: [] } });
    expect(() => EventSchemas.parse(shown)).not.toThrow();
  });
});

describe('interruptFinished', () => {
  it('keeps a client-owned timeout resumable as cancelled after its deadline', () => {
    const deadline = Date.now() - 1000;
    const event = interruptFinished('t', 'r', [
      { id: 'timed', request: { method: 'confirm', title: 'Continue?', timeoutMs: 1000, expiresAt: deadline } },
    ]);
    const parsed = EventSchemas.parse(event);
    expect(parsed).toMatchObject({ outcome: { interrupts: [{ metadata: { timeoutMs: 1000, expiresAt: deadline } }] } });
    // The SDK refuses to send a resume for a standard hard-expired interrupt.
    // Pi's soft timeout instead needs the UI to resume it with status: cancelled.
    expect(parsed).not.toHaveProperty('outcome.interrupts.0.expiresAt');
  });

  it('ends the run with an interrupt outcome AG-UI accepts', () => {
    const event = interruptFinished('t', 'r', [
      { id: 'i1', request: { method: 'confirm', title: 'Run git push?', message: 'origin feat/x', toolCallId: 'call1', expiresAt: 1792321200000 } },
      { id: 'i2', request: { method: 'select', title: 'Pick', options: ['a', 'b'] } },
    ]);
    expect(() => EventSchemas.parse(event)).not.toThrow();
    expect(event).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: 'interrupt',
        interrupts: [
          { id: 'i1', reason: 'pi.ui.confirm', message: 'Run git push?', toolCallId: 'call1', responseSchema: { required: ['confirmed'] }, metadata: { method: 'confirm', message: 'origin feat/x', expiresAt: 1792321200000 } },
          { id: 'i2', reason: 'pi.ui.select', metadata: { options: ['a', 'b'] } },
        ],
      },
    });
  });
});
