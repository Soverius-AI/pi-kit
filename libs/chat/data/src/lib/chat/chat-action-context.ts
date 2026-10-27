import type { SignalStoreFeatureType, StateSignals, WritableStateSource } from '@ngrx/signals';
import type { withChatComposerView } from './with-chat-composer-view';
type ChatView = SignalStoreFeatureType<typeof withChatComposerView>;
type Context<State extends keyof ChatView['state'], Props extends keyof ChatView['props']> = StateSignals<
  Pick<ChatView['state'], State>
> &
  WritableStateSource<Pick<ChatView['state'], State>> &
  Pick<ChatView['props'], Props>;

export type ComposerActionContext = Context<
  'draft' | 'caret' | 'caretRequest' | 'images' | 'dismissedFor' | 'chipsByThread' | 'commands',
  '_policy' | 'threadId' | 'chips'
> & {
  _internal: Pick<ChatView['props']['_internal'], 'caretN' | 'threadEpoch' | 'draftVersion'>;
};
export type BuiltInContext = Context<
  'draft' | 'caret' | 'commands',
  '_api' | '_bus' | '_injector' | '_extensions' | '_threads' | 'threadId' | 'chips'
>;
