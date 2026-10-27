# ADR-0024: Renderer state and logic live in NgRx SignalStores

Status: Accepted
Date: 2026-10-16

## Context

The renderer's state used to sit in root-provided services with Angular signals and in component fields. Each service hand-rolled the same things: a signal per field, `computed`s, methods that patch several signals, effects that react to the backend.
Components carried logic of their own (keyboard walks, menus, fetch-and-retry loops) that nothing could test without a browser, which makes the CopilotKit slot components and the panels hard to test and easy to tangle.
Reads that outlive a navigation, overlapping requests and optimistic writes need one owner each, or stale answers overwrite newer state.
`@ngrx/signals` gives a small, signal-native store: `signalStore` with `withState`, `withComputed`, `withMethods`, `withHooks`, `patchState`, `signalStoreFeature` for reusable traits, `rxMethod` for streams and `withEntities` for collections, with no actions, reducers or effect classes.
CopilotKit's assistant message injects an unscoped highlight.js theme after pi-kit's stylesheet.

## Decision

- Every piece of renderer state that outlives a component, or that more than one component reads, is a SignalStore: `ThreadsStore`, `ChatStore`, `ComposerExtensions`, `GraphStore`, `FilesStore`, `ChangesStore`, `SettingsStore`, `UpdateStore`, `TerminalStore`, `ViewPrefs`, `OnboardingStore`, `ConnectorsStore`, `AttendantStore`, `UiStore`, `ShellStore`, `PaletteStore`, `TrustStore`, `HealthStore`, `ThemeStore`, `ToastStore`, `DialogStore`, `ClockStore`. One store per domain, provided at root or at the feature boundary that owns it. This replaces root `@Injectable` services holding domain state in signals.
- Stateless classes stay `@Injectable`: the HTTP layer (`ApiClient`, `BackendService`, the `*.api.ts` classes returning typed results from `libs/protocol`), `CommandRegistry` (a dispatcher that reads and calls stores) and `MarkdownService` (`marked` plus a bounded render cache). `PkChatState` is provided by the chat page as CopilotKit's `ChatState` and only translates to `ChatStore`.
- Components render and forward intent: a component injects stores, reads signals in the template and calls store methods from event handlers. Local UI state stays in a component when no other component reads it: open popovers and menus, form helpers, the transcript's unfolded sets, the sidebar's search, rename and delete confirmation, the Changes panel's revert confirmation, the MCP app iframe state.
- Backend I/O belongs to stores, through `rxMethod` for streams (`/watch`, the terminal NDJSON, update progress, the AG-UI subscribers) or plain async methods wrapped in `patchState`.
- CopilotKit stays the source for chat data: `ChatStore` wraps `injectAgentStore` and the agent's event subscribers rather than copying CopilotKit's message state, and adds pi's custom-event state next to it.
- Shared traits via `signalStoreFeature`: `withRequestStatus()` (`requestStatus`, `error`, `loading`, `failed` and the request methods for the one request a store is mostly about), `withPersistence({ readLocal, writeLocal, remote })` (a first-paint copy in `localStorage`, the backend's SQLite as the source of truth, `persist(patch)` resolving to whether the backend took it, `loadPersisted()` validating what it reads), `withBackendEvents()` (the watchdog's status channel over the `BACKEND_STATUS` token) and `withSelection()` (`selectedId`, `moveSelection(ids, offset)` and friends).
- `withLatestRequest` owns independent reads by operation or resource key: starting a read cancels its predecessor; only the current read with a valid domain context publishes data, errors or completion; callers pass its `AbortSignal` through the generated SDK; a parent signal and store destruction cancel too. Directory reads use one key per directory; busy indicators derive from this request state.
- `withPolling` owns named polling lifecycles: read at once, wait for completion and then the interval, abort and clear when stopped or destroyed. User mutations are serialized, never cancelled like reads.
- `ThreadsStore` owns projects, threads, the trust-gated selection (newest `select` wins), polling, the remembered workspace and thread, and the watch stream as an `rxMethod` held open while a panel wants it (`want(owner, on)`) and released a few seconds after the last lets go.
- A store that follows a folder is active only while its panel is open (`FilesStore`, `TerminalStore`: `activate()` / `deactivate()` gate the effects, so a closed panel makes no request). The panel keeps one DOM job (focus, the xterm screen) behind a narrow host interface.
- `ShellStore.start()` binds `keydown` on `document` once; `handleKey` reads the combinations from `ViewPrefs.combos()`, so a changed shortcut applies at once; Esc closes the topmost thing in a fixed order (dialog, Settings, palette, pending branch, overlaying panel) and only then stops the run. Header and status-bar texts are computeds. `UiStore.openMcpPanel()` opens Settings on MCP servers directly.
- A store that talks to the DOM (`GraphStore` tinting and scrolling the transcript, `ShellStore` binding `document`) does so through one narrow method; the transcript's `data-block` / `data-after` markup is the contract between them.
- Domain features own their state: chat model and feedback are separate features from composer state; menu selection uses linked state to retain a valid entry; feedback owns per-message optimistic writes and failures restore only that message within the same thread generation; settings credentials and save tracking own their lifecycle. Public store facades stay stable; domain logic stays in its domain rather than becoming a generic CRUD framework.
- Mutations across navigation: the composer captures the thread selection generation before awaiting input transforms and validates it before clearing the draft, sending or publishing an error; each replay restarts command hydration after cancelling earlier reads. Settings mutations keep their original project, run in invocation order and render confirmed values with outstanding edits applied over them; a read started during a save cannot replace its confirmed result. Review comment drafts and writes belong to their originating thread; a failed send merges its batch back without removing newer comments.
- Persistence shares one in-flight hydration read, preserves fields edited or saving during hydration, and orders remote writes per preference.
- Layout: `apps/renderer/src/app/<domain>/<domain>.store.ts`, `<domain>.api.ts`, components beside them; cross-domain reads go through store signals, never through component references.
- The renderer has a `test` target (Angular's unit-test builder with the `vitest` runner and `jsdom`, AOT-compiled so `TestBed` and templates behave as in the app); every store has a spec with a fake API, components get thin template tests, and `*.testing.ts` fakes are excluded from the application build.
- Code highlighting colours are scoped as `:root :is(.prose, .pk-out) .hljs-*` in the design system, one class more specific than CopilotKit's injected theme, with no `!important`.
- Bundle assets: the pinned SDK patches (`patches/README.md`) use the common grammar registry, native Zod 4 schema conversion and local KaTeX font assets instead of base64 strings; rare grammars load on demand. The budget is 3.5 MB warning, 4 MB error.

## Consequences

- A component injects stores and calls methods; nothing can patch a store's state from outside (`protectedState`), so a new switch is a store method and a test.
- New features are written against stores from the start; `@ngrx/signals` is pinned exactly and upgraded with the other pinned packages.
- The e2e suite is the regression net for behaviour; the store specs cover what it cannot reach cheaply (retry timing, ordering, races between a newer and an older request).
- Stale reads and mutations cannot overwrite newer state after navigation, replay or a save; the cost is a generation check at every publish point.
- `FilesStore` and `TerminalStore` live for the life of the app but do nothing while their panel is closed; a store that follows a folder must be gated the same way.
- The design system's primitives (`libs/design-system`) remain state-free; `libs/ui` keeps pure functions that stores call.
