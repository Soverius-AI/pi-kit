import { signalStoreFeature } from '@ngrx/signals';
import { withChatComposerState } from './with-chat-composer-state';
import { withChatFeedback } from './with-chat-feedback';
import { withChatModels } from './with-chat-models';
import { withChatState } from './with-chat-state';

export function withChatDomainState() {
  return signalStoreFeature(withChatState(), withChatComposerState(), withChatModels(), withChatFeedback());
}
