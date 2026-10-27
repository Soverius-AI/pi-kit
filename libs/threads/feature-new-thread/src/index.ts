// Public API of @pi-kit/threads/feature-new-thread (`type:feature`, `scope:threads`): the page of a thread that has no message yet (heading, lead, things to pick up), the
// Where row above the message well, and the line under the well that says what Send will do. A lazy chunk: `app.config.ts` provides them to the chat page through
// `EMPTY_THREAD_PAGE` and `NEW_THREAD_COMPOSER` with a dynamic import; nothing else imports it.
export * from './lib/new-thread-page';
export * from './lib/where-hint';
export * from './lib/where-row';
