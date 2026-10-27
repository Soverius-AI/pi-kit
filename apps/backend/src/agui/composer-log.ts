import { type BaseEvent, EventType } from '@ag-ui/client';
import { type ComposerRegistration, parsePiCustomEvent } from '@pi-kit/protocol';

/**
 * The toolbar actions and suggestions extensions registered (`pi.composer` custom events) are part of the thread's replay: the
 * renderer reduces them by `id`, a later `action` or `suggestion` replacing an earlier one and `remove` deleting it. This is the same
 * reduction on the backend's side, for deciding whether a registration is news and for keeping them alive when old runs are collapsed.
 */
export function foldComposer(events: Iterable<BaseEvent>): Map<string, ComposerRegistration> {
  const state = new Map<string, ComposerRegistration>();
  for (const event of events) {
    if (event.type !== EventType.CUSTOM || (event as { name?: string }).name !== 'pi.composer') continue;
    const parsed = parsePiCustomEvent(event as unknown as { name: string; value: unknown });
    if (parsed?.name !== 'pi.composer') continue;
    if (parsed.value.op === 'remove') state.delete(parsed.value.id);
    else state.set(parsed.value.id, parsed.value);
  }
  return state;
}

/** Whether writing `registration` would change what a client reducing the log by id ends up with. */
export function composerChanges(state: ReadonlyMap<string, ComposerRegistration>, registration: ComposerRegistration): boolean {
  if (registration.op === 'remove') return state.has(registration.id);
  const held = state.get(registration.id);
  return !held || JSON.stringify(held) !== JSON.stringify(registration);
}
