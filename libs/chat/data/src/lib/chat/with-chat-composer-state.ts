import { signalStoreFeature, withState } from '@ngrx/signals';
import { initialComposer } from './chat-state';

/** Draft and attachment state belongs to the composer. Menu selection is linked to the available entries. */
export function withChatComposerState() {
  return signalStoreFeature(withState(initialComposer));
}
