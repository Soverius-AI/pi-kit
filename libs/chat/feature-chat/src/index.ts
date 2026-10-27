// Public API of @pi-kit/chat/feature-chat (`type:feature`, `scope:chat`): the chat page. Its registrations (tool renderers, activity renderers, `ChatState`) stay inside.
export * from './lib/chat-page';
// The transcript itself, for the Agents panel, which the shell hands over through `TRANSCRIPT_VIEW`.
export { Transcript } from './lib/transcript';
