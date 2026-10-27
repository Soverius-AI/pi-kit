# Repository structure

How the code is laid out and which import is allowed where. The reasoning is [ADR-0026](adr/0026-domain-structure-and-boundaries.md); this page is what to read before
adding a file or a library. The shared kernel and the rules are built, every domain (`threads`, `settings`, `onboarding`, `update`, `chat`,
`review`, `files`, `session-tree`, `artifacts`, `terminal`, `agents`) is a set of libraries, and the renderer app holds the shell only.

## The tree

```
apps/
  renderer/        Angular shell: app.config, app.ts/html, the shell store, the panel switcher, the toast host (the window has
                   no route table: one page, the panels are switched by UiStore)                                             scope:app
  desktop/         Electron main + preload                                                                                   scope:app
  backend/         NestJS (folder per domain under src/, see Backend)                                                         scope:backend
  backend-runtime/ esbuild bundles of pi, MCP, Needle and the native-module loaders for the packaged backend                   scope:backend
  secret-cli/      pi-kit-secret, the keychain helper pi runs                                                                 scope:backend
libs/
  shared/          the shared kernel, never imports a domain
    protocol/        zod schemas and types shared by backend and renderer       @pi-kit/protocol       type:util
    design-system/   tokens, CSS, Angular primitives (pk-*, pkTip, pkItem, the code editor and its tokenizer)  @pi-kit/design-system  type:ui
    ui/              what several domains show: the diff viewer, the context menu, models and thinking formatters,
                     the settings catalog, keys and shortcuts, onboarding helpers, PATH_DRAG_TYPE  @pi-kit/ui  type:util
    i18n/            Transloco setup and the English and German translations    @pi-kit/i18n           type:util
    api/             generated HTTP operations/models, authenticated transport, NDJSON framing @pi-kit/api type:api layer:transport
    data-access/     store traits ([ADR-0024](adr/0024-ngrx-signal-store.md)), toast,
                     dialog, theme, view prefs, health, redaction, clock, provider usage, CONTEXT_POLICY,
                     UiStore (the switches between components)                  @pi-kit/data-access    type:data
    testing/         thread and graph-row fixtures, fakeThreads (specs only)    @pi-kit/testing       type:util
    pi-adapter/      pi SDK events to AG-UI (backend kernel)                    @pi-kit/pi-adapter     type:util
    secret-store/    keychain and encrypted file store (backend kernel)         @pi-kit/secret-store   type:util
  threads/          the thread list, projects, worktrees, trust, the attendant's suggestions
    api/             ThreadsStore, TrustStore, AttendantStore, WorktreeStore, CoordinationStore, threadLabel, the ports ThreadShell and WorktreeReview
    data/            threads.store, trust.store, attendant.store, worktree.store, coordination.store, changed-count.store, outcome-menu.store, score.store, learn.store, learned.store (the record of learned skills), new-thread.store, ports
    util/            thread-groups, thread-state, fork-meta, sidebar, outcome, learn, where (the Where row's plan, menus, sentences and request) (pure)
    ui/              FocusSelect (the inline rename field)
    feature-sidebar/ ThreadSidebar (the rail, quick actions, Needs you, project bands and thread rows) and TrustDialog (eager, part of the shell)
    feature-worktree/ the Sync with base / Merge back / Hand off dialog (lazy chunk)
    feature-new-thread/ the page of a thread without a message and its Where row (lazy chunk, provided to the chat page through two tokens of chat/data)
    feature-learn/   the skill review dialog: read a drafted skill, Approve or Discard (lazy chunk)
  settings/         the settings dialog and everything a person configures
    api/             what other domains use: the stores, and the components onboarding shares
                     (GetModel, KeyWorkflow, LoginFlow) plus PkSetting, the row every section uses, the file editor dialog (FileEditorDialog: llama-swap YAML,
                     mcp.json and SKILL.md), and the local model runtime (LocalRuntimeWizard, LocalModelSettings, LocalInstallGuide, LlamaRuntimeUpdatesPanel)
    data/            settings.store, secrets.store, connectors.store, packages.store, provider-cards.store, project-page.store, computer-use.store,
                     litellm.store, local-runtime.store, local-model-catalog.store
    util/            the connectors' states, the rows of the Providers and MCP lists, the two wizards' step machines, the server form, the project rows,
                     the package rows with the Add a package steps, the control-column alignment check (pure)
    feature-settings/ SettingsDialog (the host) and SettingsWindow (lazy): nav, search; the General, Appearance, Voice and Computer use sections; the Versions block
    feature-providers/ Providers (the list and its "+" Add a provider wizard, the LiteLLM connection) and Models sections
    feature-connectors/ MCP servers (the connectors merged in, its "+" Add a server wizard, the server form, the edit dialog and "Edit here")
    feature-attendant/ Attendant section        feature-keybindings/ Keybindings section
    feature-projects-trust/ Projects section: the list, a project's page, its setup scripts and open worktrees
    feature-advanced/ Advanced (with "Use previous release") and Extensions and skills (Packages with the Add a package wizard, Your skills, Your
                     extensions and prompts); pk-learned-skill and pk-learned-retired (the record of a learned skill under its row, and the Retired list)
  onboarding/       the first-run flow
    data/            onboarding.store, onboarding-launch (the only part in the initial bundle)
    feature-onboarding/ the full-window cards and the strip above the chat page (lazy chunk)
  update/           pi and pi-kit updates
    api/ data/       UpdateStore
    feature-update/  the progress toast and the restart toast
  chat/             the conversation with pi
    api/             `export *` of chat/data: ChatStore, VoiceStore, CommandRegistry, the types (used by settings, files, review, session-tree, the shell)
    data/            ChatStore, CommandRegistry, ComposerExtensions, PaletteStore, UsageStore, VoiceStore, VoiceCapture, ThreadReplayAgent and
                     ThreadReplayCacheStore (the cached, delta-replayed thread log), the ports ChatTree and ChatConnectors, the slots
    util/            transcript and turn models, composer parsing, usage and voice helpers, the model picker's sections, matcher and effort-flask levels, generative-UI labels (pure)
    ui/              the model panel (the picker) and the effort flask, the skill chip, interrupt blocks, the markdown service, pk-prose (no store)
    feature-chat/    ChatPage: the CopilotKit page, the transcript and its virtual viewport, the tool-row and activity registrations
    feature-composer/ InputContainer (field, toolbar, model picker, queue bar, voice button and hint), ChatState, the agent's input container, ModelPicker (the composer chip and the header button), Palette, DialogHost
    feature-interrupts/ the interrupts section of the transcript
    feature-genui/   the A2UI catalog and loading component, genui-turn, the MCP Apps host and its registration
  review/           review mode and the Changes panel
    api/ data/       ChangesStore
    util/            the review message built from a comment batch
    feature-review/  ReviewView, ReviewTray, ChangesPanel
  files/            the Files panel
    data/            FilesStore (nothing outside the domain reads it: no api)
    util/            rows, decoration, menus, names, sizes (pure)
    feature-files/   FilesPanel
  session-tree/     the session graph, the Entries inspector, branching
    api/ data/       GraphStore
    util/ ui/        graph layout and tree model; the graph list (PkSessionGraph)
    feature-tree/    SessionPanel
  artifacts/       the desktop browser shared by the user and agent ([ADR-0029](adr/0029-browser-artifacts.md))
    data/            component-scoped BrowserStore, direct generated shared/api browser operations
    feature-artifacts/ ArtifactsPanel: address bar, navigation, expand, native viewport layout
  terminal/         the Terminal panel: data/ (TerminalStore), feature-terminal/ (TerminalPanel); no api, nothing else reads it
  agents/          ([ADR-0033](adr/0033-durable-background-agents.md)) the background agents of a thread
    api/             `export *` of agents/data: AgentsStore
    data/            AgentsStore (component-scoped: the list from the SDK, every change from the status channel through ThreadsStore.onStatusEvent)
    util/            agent states to labels and badges, durations, the Active and History lists (pure)
    feature-agents/  AgentsPanel (Active, History, questions) and AgentTranscript (the chat domain's transcript on a ChatStore for the AG-UI agent `pi-bg`)
  <domain>/        api/ feature-<name>/ ui/ data/ util/ (the shape every domain library follows)
packages/           pi packages that ship with the app (Nx projects scope:shared type:util, tested with vitest)
  pi-kit-learn/    @pi-kit/learn: /learn, the analysis prompt; talks to pi-kit through the events of doc/docs/plugins.md
  pi-kit-meat-proxy/ @pi-kit/meat-proxy: /score, the ledger, the attribution prompt and the score arithmetic; the plugin API's second consumer
  pi-computer-use/ @pi-kit/computer-use: opt-in computer use through Cua Driver (`/computer-use on`); installed into pi once like the others,
                   and uses only the one-way `pi-kit:composer` event
tools/generators/domain-lib/   the generator below                                                                           scope:tools
e2e/               end-to-end tests: Playwright driven by Node's test runner (`pnpm run e2e`; not an Nx project)
```

Nx project names: `shared-<name>` for the kernel (`shared-protocol`, `shared-data-access`, ...), `<domain>-<type>[-<name>]`
for domain libraries (`threads-feature-sidebar`, `chat-data`), and the app folder name for apps (`renderer`, `backend`).
The import alias is separate and stays short: `@pi-kit/protocol`, `@pi-kit/data-access`, and
`@pi-kit/<domain>/<type>[-<name>]` for domain libraries (`@pi-kit/threads/feature-sidebar`).

## Tags and the rule

Every project carries one `scope:*` tag and, for libraries, one `type:*` tag. `eslint.config.mjs` holds the whole rule as
one `depConstraints` block (`@nx/enforce-module-boundaries`); a violation is a lint error.

| Scope | May depend on |
|---|---|
| `scope:shared` | `scope:shared` only |
| `scope:<domain>` | itself, `scope:shared`, and the `type:api` of other domains |
| `scope:backend` | `scope:backend`, `scope:shared` |
| `scope:app` | anything |

| Type | One line | May depend on (inside the scope rule above) |
|---|---|---|
| `type:api` | What other domains import: a facade over the domain's store, selected types | `data`, `util`, `scope:shared` |
| `type:feature` | A lazy entry: container components wired to stores, one per lazy chunk | `feature`, `ui`, `data`, `util`, `scope:shared`, other domains' `api` |
| `type:ui` | Presentational components: inputs and outputs only, no store, no HTTP | `ui`, `util`, `scope:shared` |
| `type:data` | SignalStores, direct generated operations, mappers | `data`, `util`, `scope:shared`, other domains' `api` |
| `type:util` | Pure functions of the domain | `util`, `scope:shared` |

Both rules apply at once: a `scope:threads` + `type:ui` library may use `threads` utils, shared code and nothing of
`chat`; it may not use `chat/api` either, because a `ui` library never touches a store. The check is on every import
that goes through a `@pi-kit/*` alias; a relative import out of a library is an error too. `apps/renderer` is
`scope:app`, so its own folders import each other freely until they become libraries.

One more tag, `layer:transport` (on `shared/api` only), limits that library to other `layer:transport` code, so the
transport never imports a store. `tools/generators/domain-lib` is `scope:tools`, outside the rule.

The scope rule needs one entry per domain: the `domains` list at the top of `eslint.config.mjs` (the generator adds a
new domain to it).

## Adding code

- A new file goes in the domain that owns it. It goes to `libs/shared/*` only when two domains need it (the "scope
  rule" of [ADR-0026](adr/0026-domain-structure-and-boundaries.md)); until then it stays with its single user.
- A domain library is made with the generator, never by hand:

  ```
  pnpm exec nx g ./tools/generators/domain-lib:lib --domain threads --type feature --name sidebar
  pnpm exec nx g ./tools/generators/domain-lib:lib --domain settings --type data
  ```

  `--type` is `api | feature | ui | data | util`; only `feature` takes `--name` (one library per lazy entry, the others
  are one per domain). `--testing angular|node` overrides the test setup (default: `node` for `util`, `angular` for
  the rest). Add `--dry-run` to see what it would write.

  It creates `libs/<domain>/<type>[-<name>]` with `project.json` (name `<domain>-<type>[-<name>]`, tags
  `scope:<domain>` and `type:<type>`, `lint` and `test` targets), `tsconfig.json`, `tsconfig.lib.json`,
  `tsconfig.spec.json`, `eslint.config.mjs` (Angular rules, prefix `pk`), `README.md`, `src/index.ts`, a `package.json`
  that only says `"sideEffects": false` (see "Barrels and the bundle" below), and either
  `src/test-setup.ts` (angular: the Angular unit-test builder with jsdom and vitest, like `shared-data-access`) or
  `vitest.config.mts` (node: plain vitest with the `@pi-kit/*` aliases read from `tsconfig.base.json`, like
  `shared-ui`). It adds the `@pi-kit/<domain>/<type>[-<name>]` path to `tsconfig.base.json` and the domain to the
  `domains` list. The generator's own test is `pnpm exec nx test tools-domain-lib`.
- Specs sit next to the code (`*.spec.ts`). `pnpm run check` runs `build`, `eslint:lint` and `test` for every project, so a
  generated library is in the gate as soon as it exists. The Angular unit-test builder fails when a project has no
  spec at all, so a library without specs has no `test` target (delete it from `project.json` after generating, add it
  back from a sibling when the first spec lands).
- Lazy chunks stay lazy by structure: a `feature-*` library is loaded through a `@defer` block in `apps/renderer` (or,
  for the settings window, in the `SettingsDialog` host of its own library) or through a slot's dynamic `import()`
  (below); nothing else imports it.
- Barrels and the bundle: write `src/index.ts` of every library as `export * from './lib/x'` (and `export * from
  '@pi-kit/<domain>/data'` in an `api`), never as `export { X } from '...'`. In the Angular application build a named
  re-export clause keeps the module of every listed name in the bundle of whoever imports the barrel, even for names
  that only a lazy chunk uses; measured during the split, it moved the settings store, the API-key dialog and the provider cards
  (about 70 kB) into the initial bundle. `export *` is tree-shaken as it should be. A lazy component that is the entry
  of its chunk (the settings window) is not exported from the barrel at all, because the barrel would import it
  statically; the host that `@defer`s it imports it by relative path. Name clashes between a barrel's `export *`
  sources are a compile error (`TS2308`), which is how a state interface called `KeyWorkflow` and a component of the
  same name were found.
- A domain library may not import the app, and the project graph may not have a cycle (`@nx/enforce-module-boundaries` reports
  it: `chat-data -> settings-api -> settings-data -> chat-api -> chat-data`). When two domains really read each other, one side
  uses the other's `api` and the other side declares a **port**: an abstract class in its `data` that it injects, which
  `app.config.ts` (the composition root) provides from the real store (`{ provide: ChatTree, useExisting: GraphStore }`).
  There are four: `ThreadShell` (the shell store lives in the app) and `WorktreeReview` (review reads the threads) in
  `threads/data`, `ChatTree` (session tree) and `ChatConnectors` (the connectors of Settings) in `chat/data`. A new port is
  a last resort: first see whether the dependency can point the other way.
- Two **slots** are the other way a lazy chunk of one domain reaches into another's page: `EMPTY_THREAD_PAGE` and `NEW_THREAD_COMPOSER` in `chat/data` are injection tokens whose value is a function
  that loads components (`() => import('@pi-kit/threads/feature-new-thread')`, provided in `app.config.ts`). The transcript and the composer render what they load with `NgComponentOutlet`; nothing else imports the
  feature library, so it stays a lazy chunk, and the chat never imports the threads' feature code. The page and the row decide by themselves whether the open thread is a new one.

## Notes on the domain split

- `apps/renderer/src/app` holds `app.config.ts`, `app.ts/html`, `shell.store.ts`, `panel-switcher.ts` (the header's side-panel
  toggles) and `core/toast-host.ts`, with their specs. The toast host stays in the app: it is the window's toast stack, which
  happens to contain the `update` toast, so it composes two domains.
- Settings reads the chat through `chat/api` (`ChatStore.running`, `VoiceStore`); the chat reads the connectors of Settings through
  the port `ChatConnectors`, because `settings/data` imports `chat/api` first (a chat that imports `settings/api` back is a cycle).
- `CoordinationStore` (who else works in the folder, [ADR-0020](adr/0020-worktrees-and-coordination.md)) is in `threads/data`: the Files panel and review mode both show its chips.
- `ChangedCountStore` (the badge on the sidebar's "Working tree changes" button: git status of the folder in view) is in `threads/data`, and `ThreadShell.answerWaiting` is the port the "Needs you" strip answers a dialog through.
- `PATH_DRAG_TYPE` (the drag type of a Files row, read by the chat's drop target) is in `shared/ui`: two domains need it.
- What left `shared/ui`: composer logic, the transcript and turn models, usage, voice and generative-UI helpers (to `chat/util`), the files
  model (`files/util`), the review message (`review/util`), the graph layout and tree model (`session-tree/util`), the session graph
  component (`session-tree/ui`), `forkMeta` (`threads/util`). What stayed: the formatters in `thinking.ts`, `models`, the diff viewer and
  rows (chat and review), the context menu, the settings catalog, keys and shortcuts, `onboarding` (several domains read them).
- Tailwind scans the domain folders through the `@source` lines in `apps/renderer/src/styles.css`; a new domain whose templates
  use utility classes adds one.
- `UiStore` moved from `core/` to `@pi-kit/data-access`: threads, settings and onboarding all read it (which dialog is
  open, the composer requests), and a library cannot import the app, so by the scope rule of [ADR-0026](adr/0026-domain-structure-and-boundaries.md) it is kernel code.
- The `api` libraries re-export their `data` library with `export *`, so what other domains can use is what `data`
  exports. The `data` barrels expose stores and domain contracts; HTTP operations come directly from the generated shared API.
  `SecretsStore` is exported to the settings features and
  therefore visible through `settings/api`.
- `settings/api` also hosts components and a directive-like row (`GetModel`, `KeyWorkflow`, `LoginFlow`,
  `PkSetting`, `FileEditorDialog`, the local runtime wizard). An `api` may depend on its own `data` only, so this is where
  components that other domains show (the provider cards in the onboarding) and that every section library uses can
  live without breaking the rule.
- A section library is imported statically by the settings window, so all sections ship in the one lazy
  `settings-window` chunk. Making each section its own chunk would need `@defer` in the window's template.
- `apps/renderer/src/app/core/` keeps only `toast-host.ts`; everything else that was in `core/` is `@pi-kit/data-access`.
- Linting runs through the inferred `eslint:lint` target of `@nx/eslint/plugin`, which every project has (the backend,
  desktop and Node projects included); `pnpm run lint` runs it alone and `pnpm run check` runs it with `build` and
  `test`. The renderer libraries also carry an explicit `lint` target, which the generator adds. `pnpm run lint:tooling` covers `scripts/`, `tools/`
  and `packages/`.

## Generated HTTP API and configuration ([ADR-0027](adr/0027-api-contract-zod-swagger-typed-client.md))

`shared/api` owns the generated SDK and authenticated transport. Import operation
functions and `ApiClient` from `@pi-kit/api`; always pass `client` to the operation.
Stores call generated operations directly; do not add endpoint wrapper classes or `*.api.ts` proxies. Keep state, response mapping and orchestration in domain `data/` libraries. The domain `api/` folder
remains the public domain facade. Regenerate with `pnpm run api:openapi`; the full
check compares every generated file. The transport layer cannot import stores.

Each data library exports a typed `*_POLICY` injection token for its runtime behavior.
Use component inputs for instance behavior, tokens for application/domain defaults,
and reactive preference stores for user settings. `CONTEXT_POLICY` is shared by chat
and thread context indicators. Keep pure functions independent of DI by passing the
policy as a parameter. Protocol IDs and storage keys remain constants.

Chat and settings store implementation features live under `data/src/lib/chat/` and
`data/src/lib/settings/`; their store files compose those features and retain the
public facade used by components.
