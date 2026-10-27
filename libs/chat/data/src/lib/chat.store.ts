import { signalStore } from '@ngrx/signals';
import { withChatActions } from './chat/with-chat-actions';
import { withChatComposerView } from './chat/with-chat-composer-view';
import { withChatEvents } from './chat/with-chat-events';
import { withChatSession } from './chat/with-chat-session';
import { withChatDomainState } from './chat/with-chat-domain-state';
import { withChatTools } from './chat/with-chat-tools';
import { withChatTranscript } from './chat/with-chat-transcript';

export { errorText, userContent, type ImageAttachment, type Notice, type ThinkTiming } from './chat/chat-state';

/** One public facade; state, transcript, composer, actions and agent lifecycles are typed features. */
export const ChatStore = signalStore(
  { providedIn: 'root' },
  withChatDomainState(),
  withChatTranscript(),
  withChatComposerView(),
  withChatActions(),
  withChatTools(),
  withChatEvents(),
  withChatSession(),
);
export type ChatStoreType = InstanceType<typeof ChatStore>;
