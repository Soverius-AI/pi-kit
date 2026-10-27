import { type BaseEvent, EventType } from '@ag-ui/core';
import { activityId, type ComposerRegistration, type PiCustomEvent, type PiDialogRequest, piInterruptReason } from '@pi-kit/protocol';

/**
 * What pi's `ExtensionUIContext` does besides asking questions, as the host sees it. The
 * backend's UI context produces these, `PiAgent` forwards them into the run as AG-UI events.
 */
export type PiUiEvent =
  | { kind: 'notify'; message: string; level?: 'info' | 'warning' | 'error' }
  | { kind: 'status'; key: string; text: string | undefined }
  | { kind: 'widget'; key: string; lines: string[] | undefined; placement?: 'aboveEditor' | 'belowEditor' }
  | { kind: 'title'; title: string }
  | { kind: 'composer'; registration: ComposerRegistration };

const custom = (event: PiCustomEvent): BaseEvent =>
  ({ type: EventType.CUSTOM, name: event.name, value: event.value }) as BaseEvent;

/** `notify`, `setStatus`, `setWidget`, `setTitle` and an extension's toolbar registration as `pi.*` custom events and the `pi.widget` activity. */
export function mapUiEvent(event: PiUiEvent): BaseEvent[] {
  switch (event.kind) {
    case 'notify':
      // Stamped, so a replay of the log can tell a stale notification from a fresh one.
      return [{ ...custom({ name: 'pi.notify', value: { level: event.level ?? 'info', text: event.message } }), timestamp: Date.now() } as BaseEvent];
    case 'status':
      return [custom({ name: 'pi.status', value: { key: event.key, text: event.text ?? '' } })];
    case 'title':
      return [custom({ name: 'pi.title', value: { title: event.title } })];
    case 'composer':
      return [custom({ name: 'pi.composer', value: event.registration })];
    case 'widget':
      return [
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: activityId.widget(event.key),
          activityType: 'pi.widget',
          // Clearing a widget sends it empty; the renderer hides empty ones.
          content: { key: event.key, lines: event.lines ?? [], ...(event.placement ? { placement: event.placement } : {}) },
          replace: true,
        } as BaseEvent,
      ];
  }
}

/** A dialog pi is waiting on, as `PiAgent` reports it to the client. */
export interface PendingDialog {
  id: string;
  request: PiDialogRequest;
}

/**
 * `RUN_FINISHED` with `outcome: interrupt`: pi is blocked in one or more extension dialogs, the run
 * ends here, and the client's answer arrives as `resume` on the next run.
 */
export function interruptFinished(threadId: string, runId: string, dialogs: readonly PendingDialog[]): BaseEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    outcome: {
      type: 'interrupt',
      interrupts: dialogs.map(({ id, request }) => ({
        id,
        reason: piInterruptReason(request.method),
        message: request.title,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        // Keep Pi's soft deadline in metadata: the UI must resume it as cancelled.
        // A standard expiresAt makes the SDK discard that required resume.
        responseSchema: {
          type: 'object',
          properties: request.method === 'confirm'
            ? { confirmed: { type: 'boolean' } }
            : { value: { type: 'string', ...(request.method === 'select' ? { enum: request.options ?? [] } : {}) } },
          required: [request.method === 'confirm' ? 'confirmed' : 'value'],
          additionalProperties: false,
        },
        metadata: { ...request },
      })),
    },
  } as BaseEvent;
}
