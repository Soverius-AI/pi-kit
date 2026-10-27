# pi-kit design system (minimal)

The source of truth for how the app looks. It lives in the monorepo as `libs/shared/design-system`
([ADR-0008](adr/0008-design-system-lib.md)). Everything below is small on purpose: a handful of tokens, one layout
model, a short component inventory, and rules for spacing and writing.

## Who it is for and what it has to do

A developer who keeps this window open next to an editor for hours, reading streamed answers,
code, diffs and command output, and steering a coding agent. The job is long-form legibility and
calm: the content changes constantly, so the chrome must not. The one thing the app has that a
chat app does not is the session tree; that is the signature element, everything else stays quiet.

## Tokens

### Color

Two themes, one accent. Low-chroma neutral surfaces so syntax colours, diffs and generated UI stay
readable; a single amber accent that marks the active path, the current run and the primary action.
The dark theme uses neutral greys with no blue cast, the way VS Code
Dark Modern and Claude Code do: the window sits at `#141414` (below VS Code's sidebar), panels lift to `#1F1F1F` (VS Code's editor), hairlines at
`#3F3F3F` (its input border) read at a glance; text and the muted tone pass 4.5:1 on every surface, and the amber, blue,
green and red are the saturated versions that stay legible on near-black.

| Role            | Dark `pi-dark` | Light `pi-light` | Used for                                   |
| --------------- | -------------- | ---------------- | ------------------------------------------ |
| base-100        | `#1F1F1F`      | `#FFFFFF`        | panels, bubbles, menus                     |
| base-200        | `#141414`      | `#F2F3F5`        | window background, composer well           |
| base-300        | `#3F3F3F`      | `#E1E3E8`        | hairlines, rails                           |
| base-content    | `#EDEDED`      | `#1D2026`        | text                                       |
| content-muted   | `#A3A3A3`      | `#6B707A`        | meta, timestamps, hints                    |
| sunken          | `#0F0F0F`      | `#1D2026`        | terminal and code output (always dark)     |
| primary (amber) | `#E9B44C`      | `#8E6512`        | active path, running state, primary button |
| info (branch)   | `#4DAAFC`      | `#2E63B8`        | forks, labels, links                       |
| success         | `#73C991`      | `#2F7D4B`        | done, added lines                          |
| warning         | `#E2A93B`      | `#A3610D`        | approvals, compaction                      |
| error           | `#F85149`      | `#B5362E`        | failures, removed lines, abort             |

Each theme is a daisyUI theme, so daisyUI components inherit it. The standard themes remain
`pi-dark` and `pi-light`. Appearance also offers two brand-inspired skins:

- `pi-soverius`: dark navy surfaces, blue primary/selection states, orange secondary/accent,
  system sans-serif and monospace fonts.
- `pi-copilotkit`: light lavender surfaces, purple interactive states, Plus Jakarta Sans UI/prose
  and Spline Sans Mono code. The transcript has soft green/cyan radial gradients; the header
  has a subtle lilac gradient. Font files are self-hosted with SIL OFL licenses.

These skins change only color, background paint, and font families. They retain the same markup,
spacing, sizes, weights, corners, borders, and layout. Theme roles are defined in `tokens.css`;
shade with opacity rather than introducing component-specific colors. `ThemeStore.isDark()`
classifies skins for native chrome, sidebar switching, and embedded MCP apps. System follows
the OS using the standard dark/light themes; the quick toggle switches to the opposite standard
theme. Named skins are selected in Settings → Appearance and persist like the standard themes.

### Type

The standard themes use **IBM Plex Sans** for UI and prose, **IBM Plex Mono** for code, paths,
commands and anything the user might copy. Mono is not used for meta text.

| Step  | Size / line | Weight   | Use                                                            |
| ----- | ----------- | -------- | -------------------------------------------------------------- |
| xs    | 12 / 16     | 400      | timestamps, hints                                              |
| sm    | 13 / 18     | 400, 500 | lists, menus, tool rows, meta                                  |
| base  | 14 / 22     | 400      | UI default                                                     |
| prose | 15 / 24     | 400      | transcript text; fills the chat column with fixed side gutters |
| lg    | 17 / 24     | 500      | panel titles                                                   |
| xl    | 22 / 28     | 500      | dialog titles, empty states                                    |

Code blocks: mono 13 / 20. Sentence case everywhere; no all-caps labels; no letter-spacing tricks.

### Space

4px base. Allowed steps: 4, 8, 12, 16, 24, 32, 48. Rules of thumb:

- Panel padding 16; dense lists 12 horizontal, 8 vertical; menus 4 around items.
- Header rows are 48 tall with content vertically centred; status bar 28.
- Transcript: 32 between turns, 12 between blocks inside a turn, gutter 24 (16 under 768px).
- Nothing is spaced by eye: pick a step.

### Shape and depth

Radius encodes hierarchy: panels 0 (edge to edge), cards and bubbles 10, fields and buttons 8,
pills and avatars full. One shadow, used only for floating things (menus, popovers, drawers on
small screens), the `--pk-shadow` token: `0 12px 32px rgb(0 0 0 / .6)` dark, `0 8px 24px rgb(20 24 32 / .12)` light.
Resting surfaces are separated by hairlines and background steps, never by shadows.

## Controls

One size per context, and everything in a row shares it:

| Where                                           | Height | Shape                                                                                                                                                               |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolbars, headers, dialog footers               | 32px   | pills for grouped icon buttons and for chips, round 32px icon buttons for primary actions (send ↑, stop ■), round 32px ghost targets for close and the context ring |
| Dense lists (threads, files, graph rows, menus) | 28px   | rectangular 6–8px radius, no pills                                                                                                                                  |
| Inline in text (tags, labels, storage chips)    | 16px   | pill                                                                                                                                                                |

- Icon buttons are 32px, never bare glyphs: three or more related ones share one pill
  container (base-200, 2px padding); a single one is a round ghost target.
- A chip is a pill (base-200, hover base-300) with text and a 14px chevron icon when it opens a
  menu. Chevrons, carets and arrows are always icons from the icon set at 14px (chips) or
  16px (buttons); never text glyphs like ▾ or ↓.
- Round controls (the send / stop button, the context ring, close targets) are 32px discs,
  the same height as the pills beside them, so every control in a row has one visible height.
  The context ring's gauge is a 20px track and arc inside its disc (6px inner padding,
  1.5-unit stroke); the send icon is 14px.
- Controls in one row align on one baseline with 4px gaps (8px between groups); a row never
  mixes heights, and a control never truncates its label while a lower-priority control in the
  same row could collapse into a chip or an icon first.

### Icons

- There is no inline SVG in the templates. Every icon is a file in `libs/shared/design-system/src/icons/<name>.svg` (one per icon, black on transparent,
  its own `viewBox`, strokes as they should look); `pnpm run build:icons` turns the folder into `icons.css` (one `--pk-icon-<name>` data URI each) and
  `lib/icon-names.ts` (the `PkIconName` type), and `pnpm run check` fails when either is stale.
- `<pk-icon name="close" />` paints `currentColor` through the icon as a CSS mask: `color` tints it like text, so hover, state and theme colours need no
  extra rules, and the page loads no icon files (the data URIs fit the `img-src 'self' data:` policy). It is 16px; a context sizes it with
  `.ctx .pk-icon { width; height }` or `size="14"`. It is hidden from assistive technology unless it has a `label`, which makes it an image with that name.
- An icon in two colours is two masks on one element (the effort flask: `::before` and `::after`), never an SVG. A mark that arrives as data, such as a
  connector's logo from the catalog, becomes a mask with `pkIconMask(paths, style)`.
- Charts and gauges drawn from data (the run and context rings, the session graph's rows, the brand logo's facets) are graphics, not icons, and stay SVG.

## Layout

```
┌────────────┬───────────────────────────────┬─────────────────┐
│  sidebar   │          transcript           │   side panel    │
│   280      │  fluid, fixed side gutters    │   400           │
│ projects   │  full-width content           │  tree / files / │
│ + threads  │                               │  changes /      │
│ status     ├───────────────────────────────┤  terminal / …   │
│            │  composer (same gutters)      │                 │
├────────────┴───────────────────────────────┴─────────────────┤
│ status bar 28                                                 │
└───────────────────────────────────────────────────────────────┘
```

There is exactly one left column. The sidebar owns the project list (every known folder as a group with its
threads), "Add project…", the thread search and the provider/MCP status with the settings button; nothing else
lists threads or opens settings.
The side panel is opened by one segmented control in the header (Tree, Files, Changes,
Terminal, Agents, Artifacts; `pk-panel-switcher` in `apps/renderer`). When the header's available content width is 720px or less, the icons
collapse into a single ellipsis button with a popup listing each panel, its active state and
availability. This follows the chat column's width as either side column is resized. Panel contents load
when first opened, keeping their rendering code out of the initial application bundle. Review mode ([ADR-0012](adr/0012-panels-review-settings-and-trust.md)) swaps the
transcript for a diff and the composer for the comment tray; the columns stay the same.

The sidebar can be collapsed and resized on a wide window (≥ 1024): the header's leading 32px ghost
square (a panel icon, "Hide sidebar (⌘B)" / "Show sidebar (⌘B)"), the same button at the right end of the sidebar's footer and the `toggle-sidebar` shortcut (⌘B by
default, Settings › Keybindings) collapse it to the **rail** (a 48px column of project tiles, see "Sidebar") and bring it back; a 6px separator over its right border drags
its width between 220 and 480 (280 by default; a double-click resets it, ←/→ step 16px; the rail has none). The line shows in
primary on hover, focus and while dragging. Both are view preferences (`ViewPrefs.sidebarCollapsed`,
`sidebarWidth`), saved like the text sizes. Below 1024 neither control exists and there is no rail: ☰ and ⌘B open the drawer, which always holds the full sidebar.

Breakpoints and what collapses, in order:

| Width     | Sidebar                        | Side panel                 | Composer                      |
| --------- | ------------------------------ | -------------------------- | ----------------------------- |
| ≥ 1440    | open, or collapsed by ⌘B       | open when toggled          | full width, 24px side gutters |
| 1024–1439 | open, or collapsed by ⌘B       | overlays as a right drawer | full width, 24px side gutters |
| 768–1023  | drawer behind ☰ in the header | right drawer               | full width, 24px side gutters |
| < 768     | drawer, status bar hidden      | full-screen sheet          | full width, sticky bottom     |

Alignment: everything is left-aligned on the 4px grid. The transcript and composer fill the chat
column with fixed horizontal gutters: 24px, or 16px below 768px. Right-aligned items are only
trailing actions and meta in a row. Header, transcript gutter and composer share the same left edge.

## Components

Only what the app needs, all built from daisyUI classes plus the tokens:

- **Sidebar** ([ADR-0015](adr/0015-projects-and-thread-state.md)) projects are the structure; nothing in it hides behind a hover except the extra row actions. From the top:
  the 48 bar with the **search field** at the full width left of the "+" (a 32px field on base-200 with a 14px magnifier, the filter icon button inside it at the right; `⌘⇧K` focuses it, because ⌘K is the palette's;
  the filter menu holds Show archived, hidden projects and Attendant activity) and the primary `+` join (see "New-thread choice"); the static "Projects" title and the folder icon are gone. Under the bar the
  **quick-actions strip** for the current project (the open thread's, else the one picked last): a project switcher (22px tile, the name at 500, the branch in 11px mono, a chevron; its menu lists the projects and opens the one
  chosen like ⌘1…9 does) and five 26px icon buttons, each with a `pkTip` that carries the shortcut: **New worktree thread** (⌘⇧N), **Terminal in this project**, **Open in editor** (the desktop app only: in a browser the button is dimmed
  and its tip says "Desktop only"), **Working tree changes** (a primary 14px count badge, absent at 0) and **Project settings** (Settings › Projects, with the project's folder in the request for its own page). Then the scrolling list: the
  **Needs you** strip, the project groups, and **Add a project…** as a ghost row at the bottom (36px, the folder-plus icon, 13px muted). The footer has the backend dot and label, the MCP count, then 24px ghost icon buttons at the right: the **theme switch**
  (a sun while the theme is dark, a moon while it is light; a click flips between the two, "System" stays a choice in Settings › Appearance), Settings behind a gear — never a sun, so the two cannot be mistaken for each other — and, on a wide window, the collapse button (the panel icon).
- **Needs you** a strip at the top of the list that exists only while some thread waits on the person: a 10px-radius block tinted with 9 % warning, a 32px header ("Needs you", the warning colour at 12/500, "2 threads" muted at the right), then one item per waiting thread
  of any visible project, **newest first, with every waiting thread actionable** in the scrolling list. An item: the thread's title (13/18, a button: it opens the thread), the project name (11px muted, right), and under them the question's first words (12px muted, two lines at most) followed by the **answers as 20px
  pill chips**: for a `confirm` dialog **Allow** and **Deny**, for a `select` its options (the first three, then **Open**), for an `input` or `editor` dialog and for a question in prose the attendant's suggested answer when there is one and **Open** otherwise. The attendant's suggestion comes first; the first chip
  is filled with primary when it is the suggestion or Allow, the others are outlined. A chip answers the dialog through the same AG-UI resume the approval block uses, **without opening the thread** (and marks the attendant's suggestion accepted); "Open" opens the thread scrolled to its question. Items slide in and out in 160ms (motion off under
  `prefers-reduced-motion`).
- **Rail** what a collapsed sidebar is on a wide window: a 48px column on base-100 with a 32px primary "+" (new thread), a 32px warning-tinted tile with the count of threads that need you (absent at 0; a click opens the sidebar on the strip), one 32px tile per visible project (a 24px colour-keyed letter tile; a
  base-300 fill for the current project; an 8px dot at its top right while a thread of it waits (warning) or runs (primary), a tooltip "name · 2 running, 1 waiting for you"; a click opens the sidebar scrolled to that project, unfolded) and, at the bottom, the expand button. The resize edge is hidden on the rail. Below 1024px there is no rail: the drawer is the full sidebar.
- **New-thread choice** ([ADR-0020](adr/0020-worktrees-and-coordination.md)) the `+` is the left half of a 32px split button (a join of two primary squares: `+` and a 14px SVG chevron). The `+` still starts a thread in the project's folder (⌘N);
  the chevron opens a 288px menu with two rows, each a 13px title over a 12px muted sentence: **In this folder** ("Works in _name_ itself. ⌘N") and **In a new worktree** ("Its own branch and folder, cut from _main_,
  merged back when done."; disabled with "This project is not a git repository." when it is not one). The project menu has the same second row as "New thread in a worktree", and `/worktree new` does it from the composer.
  The choice is a menu, not a dialog, because there is nothing to type: the branch and the folder are named from the thread, and Settings › Projects holds where, from what and the setup command.
- **Project band** (the old 28px group row is replaced) a **full-width filled band**, 40px (34px in compact density), that bleeds past the list's 8px padding: a 16px chevron (turns a quarter when folded), a 22px **letter tile** (the first letter of the name, 11/600; the colour comes from a hash of the
  name, one of the theme's primary, info, success, secondary or a neutral, never anything outside the tokens, so a project keeps its colour), the name at 600, the branch in 11px mono with the branch glyph (truncates first; not shown while folded), and at the right the counts of running (primary tint) and waiting (warning tint) threads as 20px
  pills (a click on the waiting one opens the first question) and the ⋯ project menu, always visible. Hover or focus also shows a 26px "New thread in _name_" button before it. The band is a base-300 fill at 45 % over base-100, base-300 on hover. It is **sticky** (`position: sticky` inside the project's section, `top: -8px`
  because of the list's padding): it stays at the top of the list while its threads scroll and the next band pushes it out. **Folded**, the band keeps **mini tags** ("2 running", "1 waiting", 18px, 10px text) and, as before, the strongest other state (the context gauge, an error or aborted glyph) so a thread that needs you is visible without opening the group; nothing else
  stands beside the name and ⋯. Groups reorder by drag (a 2px info-colour line marks the drop place; the menu has Move up and Move down for the keyboard), fold, and hide (hidden projects are listed in the filter menu). 14px of air separates the projects.
- **Worktree badge** ([ADR-0020](adr/0020-worktrees-and-coordination.md); an icon since) the 13px branch glyph in `--pk-muted`, the first mark after the state on the thread row's status line;
  its tooltip names the branch, the base and the folder. A thread whose worktree is gone has none. The thread menu of such a row gains **Sync with _base_…** and **Merge back…**.
- **Outcome badge** ([ADR-0028](adr/0028-learning-from-finished-threads.md)) how a thread ended, a muted 16px glyph button (`pk-outcome`, a 14px stroke glyph in `--pk-muted`, no fill, a round base-300 hover) on the thread row's status line, after the state and the worktree mark and before the chips and the time:
  a merge glyph for `merged`, a commit dot (a ring on a line) for `committed`, a pull-request glyph for `pr`. It is not a colour signal: nothing about an outcome is urgent, so no amber, no edge bar and no unread dot. The tooltip says what and when ("Merged into main as a1b2c3d, 2 h ago",
  "Committed as a1b2c3d, 12 min ago", "Pull request opened for a1b2c3d, just now") and is the accessible name. The same badge ends the breadcrumb strip (the `crumbEnd` slot, visible on phones too). Pressing it opens the **context menu** under the badge ("Show the outcome", and for a pull request
  "Open the pull request"); pressing the badge never opens the row's thread, the menu item does.
- **Run ring** (`pk-run-ring`, CSS `.pk-run-ring`) the small gauge that says "running" without a word: a 16px track in the current colour, the context arc filled to `percent` when the context size is known (warning from 70 %, error from 90 %), and while `running` a dot that orbits the ring with a slow pulse of the whole (the one thing that turns on its own; still under reduced motion). The sidebar's running rows and the Agents panel's running agents show it, and the sidebar's context gauges (a thread's, a collapsed project's, 13px beside the percentage) are the same ring at rest; `label` is its accessible name ("Running, context 73% full"), and without one the ring is decorative, the element around it carrying the name.
- **Agent card** ([ADR-0033](adr/0033-durable-background-agents.md) §8; `.pk-agent-card` in the Agents panel) one background agent: the agents glyph, its name over its role, the permission as an outlined tag (info-tinted for edit, warning for isolated), a muted "pi-durable" tag for the runtime it survives restarts on, then the state (a held agent gets a warning-tinted block under its numbers with why it waits and "Discard and resume" or "Resume"; a History card is folded to this header and one muted line of its report, a chevron at the left opens its numbers and the whole report): the run ring with the context fill while it generates or runs a tool (its name and tooltip say which, and how full the context is), the text badge while it waits, an icon once it ended (green check done, red X failed, grey square stopped, the words as tooltip and accessible name), and icon actions at the right (eye opens the transcript, square stops, trash deletes a finished one; each with a tooltip and an accessible name). Below, one line of numbers in muted 11px: model (a long one, over 28 characters, takes its line and the numbers follow on the next), ⏱ running time (live while it runs), turns, tokens "12.3k in · 1.2k out", spend. The open view (`.pk-agent-context`) puts the brief (folded under its role), the same numbers and the tools the permission allows above the transcript, with the thread composer's well and field below it (`copilot-chat-view-input-container` of `chat/feature-composer` on the agent's own store, through the `AGENT_INPUT_VIEW` token): the Deliver chip, shown only while the agent works, says whether a message is a follow-up or a steer; the round button sends; Stop is in the panel's bar. A done agent keeps its composer (a message puts it back to work); a stopped or failed one has none. The transcript there is the thread's at the panel's density (`.pk-agent-transcript`): 12px between turns, 8px inside one, 14/20 prose, the person's messages as slim base-200 bubbles, no turn captions.
- **Context inspector** (the Session panel's third view, "Context"; CSS `.pk-context`; also "Inspect the context" in the context ring's popover) what the model sees right now, piece by piece: a head line with the model's own count against the window and the estimate ("48.2k of 200k tokens in context (estimate 46.9k)"), a progress bar, and one folded line per kind (system prompt sections, tool definitions, compaction summaries, skills in messages, your messages, model text, model thinking, tool calls, tool results, extension notes) with the count, a share bar and the tokens; opening a kind lists its pieces largest first, each a `<details>` with its label, turn, source and tokens, and the text (up to 4,000 characters, in a 320px scroll box) under it. The estimates are pi's own (characters over four, an image as 4,800 characters), so they agree with when pi compacts.
- **Lightbox** (`pk-lightbox`, `PkLightboxService`, CSS `.pk-lightbox`) the one image preview of the window, mounted once in the shell: `open({ src, caption })` from wherever an image is drawn small (a sent message's images, the composer's attachment queue; the small image is a `.pk-thumb` button with a zoom-in cursor), and the overlay shows it at the size the window allows over a dimmed backdrop, the caption under it in 12px, a round close button at the top right. Esc, a click beside the image and the button close it, and the element that opened it gets the focus back; the fade is 140ms and off under reduced motion.
- **Shimmer** (`pk-shimmer`, CSS `.pk-shimmer`) grey bars of staggered widths that sweep while a page's data is on its way, in place of the content (Settings while pi's settings load); `rows` bars, `title` makes the first a short taller one; a `status` region named "Loading…", still under reduced motion. Prefer it to a spinner wherever the shape of what comes is known.
- **Skill draft card** ([ADR-0028](adr/0028-learning-from-finished-threads.md) §2) the end of a thread that has a drafted skill (`pk-skill-draft-card`, after the interrupts in the transcript's tail): a 10px-radius row with the info tint (8 % fill, a 30 % info border; **never the warning fill, which is the approval's**), an 18px sparkle glyph in the info colour, the sentence ("The attendant drafted a skill from this thread:" or, for a draft you asked for, "A skill was drafted from this thread:") with the skill's name in 13px mono weight 500, and a **Read** button (btn-sm, no fill). It is information, not a question: it has no Approve or Discard, the dialog it opens has them. It goes when the draft is decided, and returns when a discarded draft is reopened. Below 768px the button wraps under the sentence, right-aligned. Once a verification runs the sentence gains a muted note after the name (13px, `--pk-muted`, an en dash first, `data-testid=draft-note`): "verifying…", "verified: it reproduces its thread", "verified: it reproduces part of its thread" or "verified: it does not reproduce its thread".
- **Verification box** ([ADR-0028](adr/0028-learning-from-finished-threads.md) §3; inside the skill review dialog, between the Verify first switch and "Where it comes from"; `data-testid=verification`, `data-state` and `data-result`) the report of replaying the skill from the thread's base commit, in the `.pk-wf .box` frame. The head row has the label "Verification", a state chip (`.chip` tones: **Pass** `ok`, **Partial** `warn`, **Failed** `err`, **Verifying** and **Stopped** `off`, **Could not verify** `err`; an extra `warn` chip "Edited since" when the text changed after the report) and, right-aligned, **Stop** (xs ghost) while it runs or **Verify now** / **Verify again** (xs) otherwise. _Before and between runs_: the thread's first prompt in a 12px mono textarea (the person may edit it) and a 12px hint that names the base commit, the model, the number of files it is compared with and the checks it runs again; a draft that cannot be replayed shows "Cannot be verified now: _reason_" instead. _Running_: a `loading-spinner` and the phase in words ("Making a scratch worktree at the base commit…", "The thread is running with the skill pinned…", "Comparing what it did with the outcome…", "Running the thread's checks again…") and a hint that the thread "Verify: _name_" is in the sidebar. _Done_: the summary sentence with the numbers (14px), a daisyUI `progress progress-primary` bar with "91 % of the changed lines match", the files (up to 12 rows, then "and N more": mono path, a status chip `identical` / `reproduced` `ok`, `differs` / `not in the outcome` `warn`, `not touched` `err`, and "92 %, 5 of 6 hunks" muted), the checks (mono command, `passed` / `failed (exit 1)` / `not run` chip, "passed in the thread" muted) and warnings in 12px `--color-warning`. _Stopped_ and _error_ are one sentence (error in `text-error`). Below 768px the file and check rows drop their last column under the path. The footer's primary button follows the box: **Verify first** (switch on, no report for this text), **Verifying…** (disabled), **Verify again** (stopped, failed to run, or edited since), **Approve**; a hint beside it ("Cannot verify first, so Approve goes ahead without a report.", the reason is in the box) says so when the draft cannot be replayed.
- **Skill chip on a row** the attendant's `learn` suggestion on the status line, the same pill as its label suggestion (`pk-schip info`, an outlined info pill, 18px on the status line): "Skill “add-a-migration”, drafted". Clicking it opens the thread and the review dialog (it is read, not applied); the thread menu's "Dismiss “…”" drops the chip without deciding the draft. The thread menu also gains one entry, by the draft's state: **Learn a skill from this thread** (disabled, with the reason as tooltip, for a thread without messages), **Read the skill draft**, **Reopen the skill draft**; an approved draft shows nothing there. The outcome badge's menu gets the same entry after "Show the outcome", behind a hairline.
- **Skill review dialog** ([ADR-0028](adr/0028-learning-from-finished-threads.md) §2) the workflow-dialog frame (`.pk-wf`, 820px wide on a desktop, a bottom sheet on phones, Esc closes) in three views. _Working_: a spinner and "Reading the thread and drafting a skill…" while the model works (it can be closed; the card keeps the draft). _Consent_ (the attendant is off): the sentence "This sends the thread's transcript … to _model_ …", the model as a muted chip, **Cancel** and **Send and draft** (primary). _Review_: a **Name** field (mono; it writes the text's `name:` line, so the text is the one thing saved), **SKILL.md, as pi will load it** in a monospace editor (13/20, no wrap, 16 rows, resizable; frontmatter and the `x-pi-kit` provenance visible and editable, read-only once the draft is decided), the problems in error-colour 12px under it (Approve stays disabled while there are any), **Where it goes** as two `pk-choice` buttons (_This project_ `.pi/skills/<name>/SKILL.md`, _Every project_ `~/.pi/agent/skills/<name>/SKILL.md`), the **Verify first** switch (daisyUI toggle, on by default: the primary button then replays the skill before it approves, see "Verification box" below), the **Verification box**, a **Where it comes from** box (thread, who drafted and with which model, when, and where it was written once approved), and an inline error when the backend refuses (a name that is taken: "Choose another name."). The footer holds **Discard** (ghost) and **Approve** (primary) for a pending draft, **Reopen the draft** for a discarded one and **Done** for an approved one. Writing: buttons say what happens; the toast after Approve is "Learned “name”. It is in the / menu now."
- **Learned skill record** ([ADR-0028](adr/0028-learning-from-finished-threads.md) §4; `pk-learned-skill` in `libs/settings/feature-advanced`, CSS `.pk-learned`) a skill that was learned from a thread carries its record in Settings › Extensions and skills, in a block directly under the skill's row (no card of its own: it is part of the row above, indented to the row's 16px padding, 12px under the last line, and the next row's hairline follows it). Lines, top to bottom: **the record** (12/16, `--pk-muted`, `data-testid=learned-record`): "Learned from _Add six notes_ · verified Oct 17, pass · used 4 times, merged after 3 · last used 2 h ago", the thread's title in the text colour at weight 500, the facts separated by a middle dot; a fact says what it does not know ("not verified", "not used yet", "used once, none merged after", "verified Oct 17, pass (edited since)", "a thread that was deleted" for the title); **the flag** (`learned-flag`, 12/16 in `--color-warning` with a 14px triangle glyph, only when it applies, never a fill): "Its last three threads ended without a commit, merge or pull request. Edit it, verify it again, or retire it." or the failed-verification sentence; **the run** while Re-verify works (a `loading-spinner-xs`, the phase in words as in the verification box, a ghost xs **Stop**); a refusal in 12px `--color-error`; and **the actions**, three `btn-xs`: **Re-verify**, **Edit** and a ghost **Retire**, each in a `pkTip` wrapper `span` (a disabled button keeps its reason: "It is being verified now"; all three are off while a replay runs or when the file is gone). **Retire** asks first, in place of the actions: a base-200 box (8px radius, 1px base-300 border, max 560 wide) with "Retire _name_? pi stops loading it. Its folder moves to `.pi/skills/.retired/name/` (`skills/.retired/name/ in pi's folder` for a user skill); nothing is deleted and Restore brings it back." and **Cancel** (ghost) / **Retire** (primary, xs). **Edit** closes Settings and opens the review dialog in its edit mode: the title is "Edit the skill", the name is read-only, the editor is writable, the footer is **Cancel** and **Save** (primary; off until the text changed and passes the same checks as Approve), **Verify again** works on the saved text and says "Save your edit first" otherwise, and the hint under the editor says the `x-pi-kit` block is stamped again when you save. **Retired** (`pk-learned-retired`, `.pk-retired`) is a `.pk-group` after the three resource groups, only while a skill is retired: its header is one button (a 16px chevron that turns a quarter, "Retired", the purpose line, `aria-expanded`) and an `off` count chip; collapsed by default. Opened, it has a `.row` per skill (name, an `off` chip "retired 3 d ago", "Learned from …" as the hint) and **Restore** (`btn-sm`, in a `pkTip` span) in the control column. Below 768px the actions wrap under the record and the retired rows stack as every `.row` does.
- **Outcome badge, second line and menu** while the `@pi-kit/meat-proxy` package is installed and has scored the thread, the badge's tooltip (and accessible name) gets a second line, the score's sentence, never a bare number: "62 % steered: 14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand"
  (when the outcome moved on since the hunks were labelled it ends "(the outcome has changed since; score it again)"). The badge itself does not change: no number on the glyph, no colour. Its menu gets, behind a hairline, the sentence as a disabled item and **Score this thread again**; a thread not scored yet gets **Score this thread**.
  Without the package the state carries no score: one-line tooltip, the menu is "Show the outcome" (and the learn entry) alone.
- **Thread row** a filled card on the sidebar: base-200, **inset 12px** under the band, **3px apart**, radius 8, no left bar and no separators; hover is base-300, the open thread is a 12 % primary tint over base-200 (still no edge bar). In the **Detailed** density a row has three
  lines (6px vertical and 8px right padding, 10px left): the **title** (13/18, 500 when open or unread, one line); the **summary line** (12/16 muted, one line), the first that exists of the attendant's summary, the question a waiting thread asks as a warning-outlined pill (clicking it opens the thread scrolled to the approval)
  followed by an info-outlined pill with the attendant's suggested answer when there is one ("Allow, suggested"; clicking it is the user answering with that choice, the attendant never answers by itself), the first line of pi's last answer (`ThreadSummary.lastLine`: short, redacted, from the thread index), else "N messages" / "No messages yet"; and the **status line** (11px,
  18px high): the state in words and colour, then small marks, then the chips, then the time at the right (replaced on hover or focus by the actions). The state is the strongest of: _Waiting for you_ (warning, a question-mark glyph), _The last run failed_ (error), _N % context_ from 90 % (error, a ring), _Running_ (primary, a spinner), _Aborted_ (muted, a square),
  _N % context_ from 70 % (warning, a ring), _Done, unread_ (a primary dot), else _Idle_ (muted). The thread you are looking at has no news. The marks, in order: a context ring with its percentage when the state is something else and the context is over 70 %, the **worktree** icon, the **outcome badge** (`pk-outcome-badge`), the muted `cli` mark (the session was changed in the pi command line); each has a
  tooltip. Then the attendant's label chip and learn chip. The time ("now", "12m", "2h", "Tue", "3 Oct") is followed by **⋯**, which is always visible (muted); **pin** and **archive** (22px icon buttons with tooltips; archive opens the same confirm when the thread has a worktree) join it on hover and focus. The inline rename, the thread menu, `aria-current` and the archived row's 60 % opacity are as before.
  Section headers ("Pinned", "Today", ...) appear inside a group only when it holds more than eight threads. **Compact** density ("Thread list: Compact" in Settings › Appearance, the same stored value as the old "Compact") shows the title and the time on one 28px line with the state as a small glyph before the time (and the `cli` mark); the summary line, the words and the other marks go.
- **Turn** user: base-100 block, radius 10, 12/16 padding, no avatar: the block is the marker.
  Assistant: no bubble, plain prose in the measure, no mark. The caption ("Turn 8, 12:52",
  "branched here") is hidden until the turn is hovered or focused; nothing else repeats per turn.
  Thinking rows show "Thought for 8s" only (just "Thought" when no timing exists, as for a turn made in
  the CLI); token counts belong to the usage line and are off at rest. Step lines appear only when a run has more than one step.
- **Thinking trace** a disclosure row in the same grid as an activity row: dot, "Thinking",
  a live italic line that shows the newest sentence while streaming (the dot pulses), trailing
  elapsed time. When it finishes it collapses to "Thought for 8s" (no token count);
  expanding shows the full trace in a muted, scroll-capped block with a 2px left rule.
  Streaming thinking appears exactly where it happens in the turn, including between tool calls.
- **Activity list** tool calls are rows in one list with a 2px left rule in the gutter, not
  separate cards. A row is: status dot, tool name (500), target in mono, trailing stat. A running
  row adds a second line, the latest `tool_execution_update` in one sentence (progress, last
  output line, elapsed). Expanding a row reveals output (diff, terminal, file list) in a sunken
  block. A step line ("Step 2 of 3, 4 tool calls", thin progress, elapsed) heads each step when the run has
  more than one. Since the steps live inside the work group below; the "9 earlier tool calls" fold of is gone.
- **Work group** (`.pk-work` and `.pk-work-row`) everything a turn did before its answer, as one line: "Ran 7 tool calls"
  (a chevron, muted 13px; "Working · 3 tool calls so far" with a pulsing primary dot while the turn goes). It opens into a bordered,
  8px-radius stack of rows, one per thought, step or interim text, flush against each other with hairlines between: a status dot, the
  tool and what it was given in mono ("bash node --test"), or "3 tool calls · read, bash", or "Thought for 8s", the elapsed time at the
  right, a chevron. A row opens (a `details`) into its details: the activity rows with their output, or the thought's trace. While the
  turn works the group and its newest row are open; once the answer arrives the group folds to its one line, and whatever the person
  opens stays open. Like Claude Code's "Ran 7 commands". A collapsed row's tooltip is the whole command. A message from a background
  agent (its report, a question) is one such row on the user's side (`.pk-from-agent`): the agents glyph, "From agent tester" and how
  it starts; opening shows it whole.
- **Marker** full-width hairline with a centred short label (compaction, branch switch).
- **Approval** warning-tinted block in the activity list with two buttons; it is the only element
  allowed to use the warning fill at rest. It names the question, who asked (extension and tool) and, when the
  extension set a timeout, counts it down in a muted hint line that also lists the keys (⏎ allows, Esc denies;
  ↑ ↓ and a number pick; ⌘⏎ submits an editor). A select lists its options full width with the highlighted one in the
  warning fill; an input shows its validation message under the field; on phones the buttons go under the question.
- **Composer** base-100 well, radius 10, textarea with no border, and one compact toolbar row
  of 32px controls: on the left the tools pill (⊕ @ ! as 28px round buttons inside one 32px
  pill), the model chip (with a 14px chevron) and the inline effort slider (see **The flask** below); then a "Deliver: Steer ▾" chip while a run is active (menu: Steer / Follow-up); flexible
  space; on the right, 8px apart, the **context ring**
  (a 32px disc with a 20px gauge: muted, warning from 70 %, error from 90 %; clicking it opens a
  popover with the fill, the compaction point, cost and tokens by model, and links to the usage
  dialog and "Compact now"), and one round 32px icon button: amber ↑ to send, red ■ on base-200
  to stop. No text buttons in the toolbar; shortcuts live in the hint row below the well. When
  the row is tight the "Deliver" word drops first, then chips shrink; the right cluster never
  moves or clips. Under 768px the toolbar is two rows: the tools pill with the ring and the
  send button beside the text, then the chips left-aligned; the usage popover fits the viewport.
  While dictating, the editor row is CopilotKit's waveform (its recorder in the input's
  transcribe mode, primary-coloured, the same 40px as one line of text so nothing moves); the
  words recognised so far and the state are in the hint row, the mic button turns red.
- **The flask** (first drawn as Lucide's brain) the effort control in the composer toolbar and header is an icon, slider and level: a 16px laboratory flask
  (`pk-flask`) whose primary-coloured liquid rises in the bowl by level, 0 / 15 / 30 / 50 / 65 / 80 / 100 % for off / minimal / low / medium / high / xhigh / max
  (two icon masks: `flask-bowl` filled by a gradient that stops at the level, under the `flask` outline). The stroke is muted for off, the text colour for minimal to medium, the primary from high, with a soft glow at max. The styling is `.pk-flask[data-level]` setting
  `--level` (0 to 1) and `color`, so a theme changes those rules, not the markup; the liquid moves in 220ms and not at all under reduced motion. The control is a 32px pill (flask, discrete slider, current level), with tooltip "Effort: high (⌘⇧E cycles)". The native range is labelled "Thinking effort" and exposes the level as `aria-valuetext`. Its steps come directly from the loaded model’s supported levels; a model without adjustable effort disables it and says why. Dragging previews the level and releasing saves it; keyboard arrows, Home and End also work. `/thinking` focuses this slider without opening model selection.
- **Model picker** (`pk-model-picker` hosting the stateless `pk-model-panel`) one popover for the composer's model chip (opens
  upward) and the header button (opens downward), `min(480px, 100vw − 32px)` wide, 10px radius, 120ms pop. From top to bottom: the list, which is the only part that scrolls
  (max 440px or 58vh); the **search field at the bottom** (autofocus, 32px, glob `*flash*` and fuzzy, the count "15
  models" at its right, the keys ↑↓ ⏎ as `kbd`, ⇧⏎ pins the highlighted model); the foot ("Applies to the next message. **Pin** a model to keep it here." and a link to Models and
  effort). Sections are banded rows (base-200, hairlines above and below, sticky): **Pinned** first (a 20px tile with the pin glyph in the primary, the hint "⌘⇧M cycles these · the
  pin on a row adds or removes it", "3 of 15" at the right; with nothing pinned it says ⌘⇧M cycles every model), then one section per provider in the order subscription, API key,
  environment, local: a 20px tile with the letters (a house for a local server), the name (13/600), the state chip (`subscription`, `API key`, `env`, `local`, green outline) and at
  the right the usage ("38 % of 5 h · 12 % of week" after a 56px × 3px bar, green and warning from 80 %; "credit $41.20" for a key) or the address of a local server. A provider with
  no usage source shows neither bar nor words. Rows are 40px minimum: the mono id, a 12px muted detail line (context and price, "subscription" or "free"; Pinned rows start with the
  provider), the badges (default in the primary, thinks, virtual) and the **pin** (a 24px ghost button around a 16px glyph, visible on hover and focus, amber when pinned; it toggles the
  pinned set and does not close the picker). The current model has the base-200 fill, the keyboard cursor a 1px primary outline. A pinned model is listed in Pinned only. Under 480px the
  plan name, the second usage window and the bar drop.
- **Skill chips** a skill or prompt template picked in the composer is a chip in the well's chip row, not text: a 24px pill (base-200, hover
  base-300) with `/skill:` (a prompt template: `/`) in muted mono, the name (500), a 10px scope badge with an info outline (`user`, `project` or a package name), a 16px
  round pin that appears on hover or focus (always on touch; filled and always shown while pinned) and a 16px round close with a 12px SVG cross; no amber, no edge bar.
  A pinned chip is dimmer (a hairline instead of the fill, muted name) because it rides along on the next messages. The row is one wrapping strip, 12px above and
  16px at the sides, 8px between: the skill chips, then CopilotKit's attachment queue (48px image thumbnails, 28px mono `@path` chips), all centred on one line. In
  the transcript the same pill is read-only (no pin, no close; a pin mark on a pinned one) above the sentence of the user's bubble, 8px over it.
- **Queue bar** docked onto the well as one unit while a run is active and something is
  queued (square joint, base-200 on base-100): a 32px header "Queued" with the count as a 16px pill tag, then the delivery rule ("steer goes
  after this turn, follow-up after the run") with Merge and Clear all on the right (Merge joins
  every queued message into one steer, in order, which Edit can then refine), then 36px rows with a fixed kind
  column (steer in amber, follow-up muted), the text on one line, and actions that appear on
  hover (Steer now for a follow-up, Edit = back into the composer and out of the queue) next to
  an always-visible Remove. Each row sits in an `.item`; its text is a button that opens the row's actions on phones. Gone when the queue is empty. On phones the header keeps "Queued",
  the count and the two links on one line (the delivery rule becomes a tooltip), and rows keep
  the kind, the text and Remove, with Steer now / Edit behind a tap on the row.
- **Command menu** popover above the composer, 480 wide, grouped list, one line per command:
  name in mono, description in sm, source badge trailing.
- **Session graph** git-log style rows: 36px two-line rows with a
  lane cell on the left at a 28px lane pitch (lane 0 amber 3px = active path, other lanes at
  30 % content colour, nodes 10px). Title line: turn number (muted), the first sentence of the
  user message, label pill. Sub line (12px muted): what the turn did, tool names in 500 weight,
  then tokens and model when they changed. Trailing: time; on hover or selection the time swaps
  for inline actions (Go here, Edit and branch, Fork, Label, More). Abandoned branches fold into
  one tinted group row ("Branch A, 2 turns, summarised", chevron to expand); expanded side turns
  keep the tint. Compaction is a 28px band across the lanes with a hairline and the warning
  square. Glyphs: circle; filled amber with glow = leaf; dashed = branch summary; dashed hollow =
  the ghost "next turn" row. Each turn node carries a thin ring whose arc is the share of the
  context window in use after that turn (muted, warning from 70 %, error from 90 %); the arc
  drops visibly after a compaction band, and the row's time tooltip gives the exact figure. A sticky foot shows "Turn 7 of 11 · main › fork at turn 6" and
  "Jump to current"; the panel header has a find box and the "Fold side branches" toggle. Past
  200 rows the list is windowed ([ADR-0014](adr/0014-files-decoration-and-graph-v2.md)). The find box filters the rows and marks the match, the fold choice is
  remembered per thread, hovering a turn tints it in the transcript and clicking one on the active path scrolls the
  transcript to it, and the selected-turn card is gone.
- **Breadcrumb strip** 28px row above the transcript listing fork points on the active path
  ("fork at turn 4" in the info colour, earlier ones folded into a count) and the current turn. In
  review mode it holds the file tabs instead. A thread in a worktree starts the strip with its **branch crumb** ([ADR-0020](adr/0020-worktrees-and-coordination.md)): the 12px branch glyph and the branch name in the text colour (not the info colour,
  which is for fork points), its tooltip the base and the folder.
- **Generated UI frame** ([ADR-0011](adr/0011-generative-ui-and-mcp.md)) a hairline box, radius 10, around anything an agent or an MCP server draws in
  the transcript: a 36px bar (status dot for MCP Apps, title in 500, a badge for a count, the tool in muted, and
  on the right in xs muted what it is: "Rendered from A2UI", "MCP app, sandboxed"), then the surface. The bar
  is the app's and says where the UI comes from; a surface can set its title and badge, never that label. Since [ADR-0011](adr/0011-generative-ui-and-mcp.md)
  the frame is the catalog's root `Card`, drawn inside CopilotKit's own A2UI renderer, and carries the turn's
  attributes like any other piece. The catalog's `Row`, `Column`, `Badge` and `Table` are daisyUI classes
  (`table table-sm`, `badge`), flush by default so a table and a hairline run edge to edge, `inset` pads a container
  12px; the other components are CopilotKit's, themed by `.pk-a2ui` through its `--a2ui-*` variables (the tokens as
  colours, no margins of their own, controls at the 32px height of `btn-sm` and `input-sm`, headings in the 500
  weight at 20/18/16px). A surface writes its data as an object (`updateDataModel` at `/` with `{ specs: [...] }`).
  MCP Apps draw on the base-200 page colour and receive the theme as MCP Apps style variables.
- **MCP servers dialog** ([ADR-0011](adr/0011-generative-ui-and-mcp.md)) a modal like `/session`: one row per server with a status dot (success
  connected, warning connecting or needing sign-in, error failed, hairline grey off), name, scope and
  exposure badges, tool count, state in words, the command or URL in mono and, if it failed, pi's error in a
  sunken block; row actions are text buttons (Sign in primary, Reconnect, Sign out, Disable / Enable). Opened from
  the sidebar footer's "N MCP servers" or `/mcp`; since it is the MCP servers section of Settings, not a
  dialog of its own, and the rows are the same.
- **Diff viewer** ([ADR-0012](adr/0012-panels-review-settings-and-trust.md)) mono 13/20 in a base-100 box: header with path, origin and ±counts;
  rows of comment gutter (28), old and new line numbers (44 each, muted), code. Added and removed
  lines use the success/error tints at 14%; hunk headers use base-200. Hovering a row shows the
  amber `+` in the gutter; the rows a comment covers are tinted amber at 12% and its card sits
  directly under the last of them. A comment covers **one line or a range**: drag from one `+` to
  another, or click one and shift-click another, on the same side (old or new); the card's
  by-line says "Comment on lines 38–42" and the batch carries `line` and `endLine`. Long lines
  scroll the whole diff body horizontally, never one row at a time; on phones the old line-number
  column collapses and lines are clipped with an ellipsis.
- **Comment card** base-200, radius 8, sans 13/18, spanning the diff's visible width (sticky, so
  it stays in view when the rows scroll sideways; never indented to the code column): a by-line
  ("You, pending", "lines 38–42" for a range, with Edit/Delete), the text, or a textarea with
  "Cancel" and "Add to batch".
- **Comment tray** replaces the composer in review mode: count and file chips on the left,
  "Discard all" and the primary "Send N comments to pi" on the right.
- **Outcome source** ([ADR-0028](adr/0028-learning-from-finished-threads.md)) the third toggle of the Changes panel's source join, after "This thread" and "Working tree": "Outcome" (`btn-xs join-item`, same states). It is disabled, with a tooltip that says what gives a thread an outcome, until the thread has one. The file list and the diff
  are `git diff base..head` of the outcome in the thread's folder (the project's once its worktree is gone); the review header and the diff subtitle say "in the outcome, merged as a1b2c3d". Comments work on it like on any source; Revert file and Stage all are disabled (it is committed history).
- **Score meter** `pk-score-meter`, at the top of the Outcome view's main column while the thread is scored: a base-200 box, 10px radius, 1px base-300 border, 12px 16px padding. First line (14/20): **"62 % steered"** (600) and "38 % vibe" (muted), and "1 label corrected by you" (muted) when the person relabelled;
  then a 6px bar (a pill, base-300 track, the steered part in `--color-primary`: the primary tint is the person's, pi's own share stays the track), then the rest of the sentence (12/16 muted: "14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand"). When the labels are out of date the sentence ends, in warning, "The outcome has changed since; score it again." It describes a thread; it is no grade, so there is no red/green and no scale of "good".
- **Hunk label** in the diff viewer's hunk row (the base-200 `@@` row), after the header: a pill (18px, `pk-hunk-mark`, 12/16) with the label word, then the trace in muted 12px (what the label traces to, in the model's or the rule's words), then a `select-xs` "Relabel…" at the row's right edge (`pk-hunk-rel`). Tints: **specified** primary, **corrected** info, **manual** success (14 % fill, text in the colour), **autonomous** the muted base-300 pill: steered is coloured, pi's own is not.
  A label the person set has a 1px outline in the pill's colour and the tooltip "You said specified (was autonomous): …"; its control also offers "Back to the model's label". Choosing a label sends it (`POST /api/threads/:id/score/relabel`) and the meter moves; the model is not called. On a phone the row wraps (the header, the pill and the trace on one line, the control under them). Without the package the row is the plain header.
- **Score histogram** `pk-score-histogram`, one per project in Settings › Projects and trust, in a **Steered or vibed** group (`.pk-group`, a row per project with its scored count as an `off` chip): ten columns (0–9 % ... 90–100 % steered) 72px high with 4px gaps, primary fill, 3px top radius, the tallest column the full height and an empty column a 2px base-300 rule so the scale stays readable;
  under it the axis ("0 % steered" ... "100 %"), the average in a sentence ("On average 62 % steered over 7 scored threads."), and the newest scored threads as a list (the number in 600 and tabular, the title muted and truncated, the sentence as its tooltip). No ranking, no target line. The group is not there while the package is not installed.
- **Diff viewer, split and compact** ([ADR-0012](adr/0012-panels-review-settings-and-trust.md)) split puts two halves in a row (old and new, each with its own gutter, number and
  code; removed lines pair with the added ones that replace them, the empty side is base-200). Before and After each occupy
  half the available review width, including for long lines. Their horizontal scroll offsets stay synchronized; one vertical
  scroll and shared row heights keep code, hunk headers and full-width comment cards aligned. `compact` is the variant inside a transcript row: no header, no gutter, no frame, line numbers only, capped at 320 high. On
  phones the diff is always unified.
- **Files panel** ([ADR-0012](adr/0012-panels-review-settings-and-trust.md)) the folder as a tree of 28px rows: a 16px twisty, the name (folders 500), an arrow button on hover that
  opens the file in the editor; children are indented 16px behind a hairline; the selected row has base-200 and the 3px amber inset.
  A filter field above searches the whole ignore-aware index; rows are draggable into the composer as `@path`. [ADR-0014](adr/0014-files-decoration-and-graph-v2.md) adds the
  decoration: a 16px icon by file type (`pk-file-icon`: folder, code, config, markdown, image, lock; tinted with tokens at 55–85 %), a
  16px git badge letter after the name in the Changes panel's tints (M warning, A and U success, D and C error, R info; the same
  size and radius as the Changes panel's), a 6px dot on folders with changes inside, a `π` in the amber accent for a file pi
  changed in this thread (apart from the badge), size and time in muted xs at 1440 and wider, ignored rows at half opacity
  behind a "Show ignored" toggle, a deleted file struck through. A right click or ⌘-click opens the **context menu**: a floating
  base-100 menu, radius 10, the shadow token, items 13/18 with 6/8 padding, hairline separators, destructive items in the error
  colour; it is the one floating surface of the panels (the session graph's "More" uses it too).
- **Lease chip and "Also working here"** ([ADR-0020](adr/0020-worktrees-and-coordination.md)) a file another thread edited in the last 30 minutes carries a 16px warning-tinted pill after the name (and after the `π`): a 12px pencil, "being edited by" and the other
  thread's title in 500, truncating the title first (under 480px the words "being edited by" drop and the pencil and title stay); its tooltip adds how long ago and that nothing stops you. Only files get one, never folders. Under the
  filter field a line of 16px pills names the other agents next to the thread ("Also working here": a running one in the primary tint, a waiting one in warning, **pi in a terminal** muted, an idle thread's title plain), and
  is absent when nobody is. In review mode the diff of a leased file is headed by a warning-tinted note (8px radius, a 14px pencil, one sentence); a file with unresolved conflicts gets an error-tinted note and a `conflict` badge in the Changes panel.
- **Worktree dialogs** ([ADR-0020](adr/0020-worktrees-and-coordination.md)) **Sync with _base_** and **Merge back into _base_** are the workflow dialog's frame (`.pk-wf`: 560 wide, a bottom sheet on phones, head with the round 32px close target, body, foot with the buttons
  at the right). A base-200 box first: the branch chip (info outline) and the base chip (muted) joined by a 14px SVG arrow, and one muted line, "2 commits ahead, 1 commit behind main; 3 files with uncommitted changes".
  Then the choices as **choice rows** (`.pk-choice`: a 1px base-300 outline, 8px radius, a 13/500 title over a 12px muted sentence; the selected one is the filled base-300, never an edge bar): Merge or Rebase for a sync; Merge into
  _base_ or Open a pull request for a merge back (the pull request row is disabled with the reason, "no remote" or "gh is not installed"). Merge back adds the commit message (a textarea, five rows, prefilled from the changed
  files, with a hint that says what it is for) and a checkbox "Remove the worktree afterwards" (on). Conflicts are an error-tinted box in the body: "1 file has conflicts", the files in 12px mono, one sentence, the primary
  **Review conflicts** (opens review mode on the working tree) and a ghost **Abort the merge**. After the action the footer's button becomes **Done** and the body ends with one line of result (success colour for a merge). Archive and
  Delete of a thread with a worktree show the same two choice rows, **Keep the worktree** (default) and **Remove the worktree**, with a warning sentence naming the uncommitted changes that would be lost.
- **Terminal panel** ([ADR-0012](adr/0012-panels-review-settings-and-trust.md)) xterm.js on the sunken colour (dark in both themes), 13px mono, ANSI colours from the tokens
  (error, success, warning, info, primary); the bar says which shell runs where and has Restart.
- **Settings dialog** (replaces the tabbed dialog of [ADR-0012](adr/0012-panels-review-settings-and-trust.md)) a modal 1040 × 720 (full screen under 768):
  a 56 header with the title, a search field, the "Saved" tick (success colour, a spinner while saving) and the close button;
  a 232 nav on base-200 with three headings (App, pi, Workspace), 32 rows with a 16px outline icon, a count or chip at the right
  and the selected row in base-100 at weight 500, no edge bar (a horizontal strip of tabs on phones); the page on the right with a
  22/28 title and a muted line, then **groups** (`.pk-group`: base-200 header with a 14 title, a 12 muted purpose line and
  actions, rows below). A **row** is the name with a small info-colour chip that says where the setting is stored (`pi settings.json`,
  `pi-kit database`, `project .pi/…`), the 12 muted description, and the control on the right (toggle, select, join of radios);
  it stacks on phones. Every choice is a row of its own : the attendant's schedule and its cost cap are one row per choice, never several labelled controls inside one control
  (the **options grid** `.pk-opts` is no longer used by a settings row). State chips: ok, warn, err, off. A reload banner (warning tint) sits under the header when a change needs
  a session reload. Provider cards (`.pk-provider`) carry state in words and colour and never an amber button (the one primary
  action is "Add API key…" in the group header); a model or pinned-model card is `.pk-model-card` with a drag grip.
- **API key workflow** a 560 dialog above Settings (a bottom sheet on phones) with four steps and a dot
  row: provider, where to get a key, a password field with no reveal toggle and a shape line (success / info / warning dot),
  and the result card (chip validated / rejected / not checked, models, "Saved as OpenRouter key ending in a1b2, auth.json, today").
  A key is never displayed anywhere.
- **Connectors** ([ADR-0018](adr/0018-connectors.md); as first built, before they merged into Settings › MCP servers and the card became a `pk-item` row, see **List pages**) one group, one **card** (`.pk-connector`) per connector: the provider card's grid with a 32px logo tile (base-200, 8px radius, an 18px monochrome mark in the text colour,
  never a vendor colour) in place of the dot, the name (14/500) with a state chip, a muted count ("2 tools") and an `apps` chip, the 12px muted one-line summary and a second line for how it signs in, and the actions at the right: one primary
  button (amber "Connect" only while the connector is not connected; "Sign in" or "Try again" when it needs the person), a ghost "Disconnect". States are words and a chip, never colour alone: not connected (off), connecting and signing in
  and needs sign-in (warn), connected (ok), error (err) with pi's own error text in a 12px mono box on base-200 and a link to the vendor's documentation under it. Under the text a row of controls, all 32px: the **Project only** toggle, an
  Access select for a read-only variant, the **Tools** select (Direct, Codemode, Deferred, with the meaning as its tooltip) and, once connected, a "Show tools" chip with a 14px SVG chevron that turns when open; the tool list is a two-column mono
  name and muted description, hairlines between, an `app` chip on a tool that opens an MCP App. A sign-in that waits is a panel on base-200 inside the card: one sentence, the authorization link (12px mono, truncated) with a "Copy link" button at its end,
  "Cancel sign-in" and "Browser on another machine?" (which reveals a field for the redirect URL). The panel and its link are in the card that waits, not in a banner above the list; a notice above the list is only for what has no card (an error, "Trust this folder").
  A token or a client secret is never an inline field: it is the dialog below. The custom server is the last card with "Add…". Under 768px the actions drop under the text, like the provider card. In the `/` menu a connected connector is a group titled "Connectors", before the skills,
  with one line "Linear: create issue, search issues…" and a `connector` badge.
- **Connector dialog** ([ADR-0018](adr/0018-connectors.md)) the API-key workflow's 560 dialog (`.pk-wf`, a bottom sheet on phones, height by content) with one step: a password field with no reveal toggle and a hint that says where the secret goes before it is typed
  ("It goes into your macOS Keychain; pi's mcp.json holds only the command that prints it"), or the client id and secret of the person's own app, or a custom server's name, kind (URL or command) and address. Cancel (ghost) and the one primary Connect.
- **Trust dialog** 440 wide (520 for `/trust`, which adds the destructive "Never trust" on the left): the folder in
  mono, one sentence, one row per project resource (badge: extension outline, skill info, mcp warning; path in mono; server count
  muted), then Skip this time (ghost), Trust once and the primary Trust and remember.
- **Onboarding** a full-window flow on base-200: a 280px rail on base-100 (below 1024px a row above the card) with the
  brand, five steps (a 24px numbered disc: amber filled for the step in progress, success outline with an SVG check when done, muted otherwise; title 13/500 and
  a 12px muted sub line) and "Skip setup, I know pi" at its foot; one card at a time, 720px wide, an h1 (22/28, 500), a muted lead and the card's content, and a foot
  row of 32px buttons (ghost Back with a 16px SVG chevron at the left, the one amber primary at the right, a muted status phrase between). The "Found:" box is a
  base-100 panel with 1px base-300 border and 10px radius; each finding is a phrase with its subject in 500. A way to get a model (**provider card**, `.pk-prov`)
  is a 10px-radius row: a 40px tile (base-200, an SVG icon or the initial of Radius tinted amber), the name (14/500) with state chips, one 12px muted
  description, the status of what is already set up through it (12px, success colour, one line per credential: provider, last four characters, store, models), and the
  action at the right (below 1024px it takes its own row). Radius carries a 55 % amber border and the chip "recommended by pi"; no other card has amber. The local card
  expands into a panel under it (detected servers, an address field, Test connection, instructions when nothing answered). The last step is not a card: the flow
  docks into a 88px strip (136px on a phone) at the top of the main column above the real chat page: five amber dots, "First prompt", a state chip (`pi is ready` in
  success, `pi is not ready` in error, a spinner while it asks), the reason truncated, Back and "Finish setup", and a second row of three 32px pills with the suggested prompts.
- **New thread** a thread without a message shows a page in the transcript's place and the **Where row** in the composer. The page (`.pk-start`,
  640px column, 10vh from the top): the question "What are we doing in pi-kit?" (22/28, 500), one 14px muted lead, and up to two tiles (`.pk-recent`, two columns, one on a phone: the title in 13px, a
  12px muted line under it) for the last thread of the project to continue and an unsent draft. The row (`.pk-where`, a 10px-radius card on base-100 with a 1px base-300 border, 8px 10px padding, 8px
  gap) sits directly above the well: the **top line** holds the project button (folder glyph, name 500, chevron; opens the list of projects), the Local | Worktree join (28px buttons, a 14px glyph each, the
  chosen one `btn-active` and 500), one 12px muted sentence ("in ~/Development/pi-kit as it is", "a fresh checkout under ~/.pi-kit/worktrees/pi-kit/") and, pushed to the right, a 12px Remember checkbox. Under a
  hairline, the **grid of three labelled slots** (12px muted label, 28px base-200 value button with a 12px mono value and a 12px chevron): **branch · from · setup**, the same three for both modes, so switching
  the mode changes values and never the layout (the values fade in over 160ms). Local: the branch menu, "the folder as it is" (tooltip: N uncommitted files stay), the script or none. Worktree: `<prefix><name>`,
  detached or a typed name; the base with `origin/<branch> (fetch first)` and the checkbox "carry N changes"; the script (the first is the default) or none. A menu (`.pk-where-menu`, 360px, 10px radius, `--pk-shadow`,
  opens upwards because the composer is at the bottom; on a phone it spans the card) lists entries with a mono name and a 12px muted line; one that cannot be chosen is 50 % and keeps its reason in that line
  ("stash or commit the 3 files first", "held by the worktree of “Settings v2 proposal”"). The crumb line says where the thread will run, the hint under the well says what Send will do
  ("Sending makes the worktree pi-kit/<name> from main, carries 3 files of changes, runs npm ci, then starts the thread in it."). Both go with the first message. On a folder that is not a repository the row
  shows the project and its sentence only.
- **Toast** daisyUI `toast` at the bottom right above the status bar, `alert-soft` in the level's colour, with Dismiss; for
  things that belong to the window (a file that cannot be opened here, a revert that happened), not to a transcript.

- **Tabs** (`PkTabs` and `PkTabPanel`) use a segmented, horizontally scrollable tab strip with one selected panel. Each panel has a stable ID linked to its tab, and only the active tab is in the tab sequence. Left/Right wrap across enabled tabs; Home/End select the first/last. Selection follows focus. Inactive panels stay mounted and hidden so drafts, selection and scroll positions survive tab changes. Use `[(value)]` for controlled navigation, a descriptive `label` for the tab list, and unique panel `value`s. Counts are optional; disabled panels cannot be selected. Colours use the theme tokens and transitions respect reduced motion.
- **Scroll area** (`PkScrollArea`) gives a long list its own labeled, keyboard-focusable scroll region. The default height cap is `min(22rem, 42dvh)`, configurable with `maxHeight`. It contains overscroll and reserves scrollbar space. Keep selected-item details and primary actions outside the scroll area. Local model downloads use this to separate search results from file review and consent.
- **List pages** Providers and MCP servers show **what is configured and nothing else**; adding is a wizard behind the group header's one amber square "+".
  It replaces the provider card (`.pk-provider`), the connector card (`.pk-connector`) and the MCP row (`.pk-mcp-row`), which are gone from `components.css`.
  - **`pk-item`** (`[pkItem]`, `libs/shared/design-system`) is the row: a 32px tile (base-200, 8px radius; two letters in weight 600, or a 16–18px outline glyph or the catalog logo in the `[tile]` slot), the **name** (14/20, `[nm]`) with its chips
    (state: ok / warn / err / off; scope; a muted count like "17 models"), **one detail line** (12/16 muted, `[ds]`: what the thing is, or the credential line "key ending in a1b2 · macOS Keychain · added today",
    never the key), the **actions** on the right (`[act]`: ghost icon buttons of 32px with a 16px glyph in the muted colour that darkens on hover; at most **one text button**, amber only when it is the next move, "Sign in")
    and, under the text, what the row opens (`[extra]`: a sign-in panel on base-200, an error box in 12px mono, the tool list). A row that is off is drawn at 60 %. Rows are separated by hairlines. Under 768px the actions drop under the text.
  - The group header carries the title and purpose, the storage chip (its tip is the file), ghost actions (Reload, Check for updates) and **one amber `btn-sm btn-primary btn-square` "+"** (tip "Add a provider" / "Add a server"),
    aligned right on the title's line on phones. The empty state is an invitation inside the group ("No providers yet. Add one to get models.") with the same "+" as a text button. A read-only group ("Keys from the environment") has
    the `read only` chip and rows without icons.
  - **A wizard** is `.pk-wf` with the dots in its head, the close button with the tip "Close (Esc)", a body of one `.wstep` (slides 24px in the direction of travel, 160ms) and a foot with "‹ Back", the step hint ("Step 2 of 4, next: sign in") and the
    primary button on the right (Cancel before it where the wizard has details). **`pk-choices`** are two across (one column under 768px), **`pk-gallery`** three across with a 360px scroll: a tile is a `button[pkChoice]`
    with a 36px (32 in a gallery) tile, the title (14) with chips, one 12px muted line; the recommended one has an amber outline (`recommended`), the picked one a tinted fill and `aria-pressed`. Radius is the one that is recommended.
    A **searchable list** (`.pick`) has 24px letter tiles and an `ok` chip for "signed in". A form in a dialog is **`pk-form`**: a 140px label column and a filling control column, hints under the control in the same column
    (under 768px one column); a secret field is a password input with no reveal toggle (see Secrets) and a hint that says where it goes. The result of a check is a `.box` with one line: an `ok` or `err` chip and the words.
  - **The API-key steps are reused, not copied:** `pk-key-workflow` renders its body and footer (`[embedded]`) inside the Add a provider wizard's window; Done, Back and the "Make … the default for new threads" switch (`[done]` slot) are the wizard's.
  - **Control column**: `--pk-ctl-w: 320px` (tokens), and a settings row's control is `class="ctl ctl-w"`: the control column of that width on the right, selects and inputs filling it, labels and hints always in the left column.
    It was applied first to the rows of the files group, then to every other section (see Alignment, under Projects).
  - **`pk-quota`** is a 72×4px bar (success, warning from 80 %) with words ("5-hour window 38 %, resets 14:30"); it renders only when the provider reports usage (`ProviderInfo.usage`).
  - A **More** menu on a row is the floating context menu (`pk-context-menu`, one allowed floating surface) opened at the button, not a dropdown inside the group, which would clip.

- **File editor** ("Edit here"; `pk-code-editor` in `libs/shared/design-system`, the dialog `pk-file-editor-dialog` in `settings/api`) is a text editor for llama-swap YAML and the two `mcp.json` files. `.pk-editor` is one scroll container (vertical to 380px or half the window, horizontal when a line is long) with a 36px **gutter** of line numbers (mono 12/18, muted, sticky on the left) and the code. The code is a plain `<textarea wrap="off">`
  laid over a `<div class="hl">` that draws the same text in colour (same font, same 8px 10px padding, same 18px lines), so selection, undo, the clipboard and the input method are the browser's; the text of the textarea is transparent and only its caret
  (`--color-base-content`) shows. Colours are tokens: property names `info`, strings `success`, numbers and `true` / `false` / `null` `warning`, punctuation muted; in Markdown headings are semibold, list markers and the frontmatter's colons muted, code `info`. The
  tokenizer is `tokenize(text, 'json' | 'yaml' | 'markdown' | 'text')`, a line at a time, and keeps every character, so a text with an error in it still shows all of it; above 200 000 characters the colours are skipped.
  **The line with the problem** is tinted (`error` at 12 %) and its number is red and bold with a 2px red bar; under the editor a status line (`.pk-editor-status`) has a 8px dot, green with the one-line summary ("Valid · 3 servers · ⌘S reloads them") or red with
  "Line 13: exposure must be one of codemode, deferred, direct, hidden.", and the keys ("⌘S saves · Esc closes") on the right. **Save is disabled while the text is invalid** and while nothing changed. ⌘S / Ctrl+S saves,
  Enter keeps the indentation (and goes one level in after `{` or `[`), Tab is left to focus. The dialog is `.pk-wf` `.win.wide`: the path in mono and a scope chip, "changed 2 h ago", and in the foot "Open in editor" (the default application, desktop only), Revert and the
  primary button ("Save and reload", "Save"). A save sends the modified time or content version the editor saw; a file that changed since is refused ("The file changed since you opened it. Reload and try again.") and Revert becomes **Reload**. Closing with unsaved changes asks once
  ("Discard your changes?", Keep editing / Discard). It is a lazy part of the section that opens it.
- **The server form** (`pk-server-form`) is a `pk-form` of Name, Runs (URL or command), URL + **Headers** or Command + Arguments (one line, quotes group one) + **Environment**, Tools, Description, Scope (fixed when editing) and, editing,
  Enabled; under it a collapsed "As it will be written" (the entry as JSON, live; a secret shows as the command that prints it, never the value). **`.kvs`** is the key/value rows of Headers and Environment: key, value, a 28px lock ("Keep the value in your keychain"), a 28px ×,
  and a small "+ Add a header / a variable" under them, all in one grid so the columns line up. A value that is a secret (the lock, a name like `Authorization`, `X-Api-Key`, `GITHUB_TOKEN`, `DB_PASSWORD`, or the shape of a key) is a **password field with no reveal**;
  a value the file already keeps in the credential store shows the green placeholder "Stored in your keychain · type to replace" and is kept unless something is typed over it. The page never holds a typed secret in a signal and never renders it.
- **Packages** are `pk-item` rows in three groups. **Packages**: the tile is the package glyph; the name with an `ok` / `off` chip for on/off, `bundled` or `project` when it is, the version (muted mono), and
  the amber-outlined **outdated chip** "0.4.0 → 0.5.0" (`update available` for a git source); the detail line is "2 extensions, 3 skills · `npm:pi-subagents` · installed Oct 3" (a folder shows its path, a package that ships with pi-kit "ships with pi-kit"); the actions are
  **Update** (a text button, only when behind), the on/off toggle ("Load this package") and More (Update, Remove…). A package that is configured but not on disk has an `err` chip "not installed". **Remove…** asks in the row (a `.signin` box: "Remove X? pi runs `pi remove` for it",
  Keep it / Remove). Under the row a "Show what it brings" disclosure lists the package's extensions, skills and prompts with a switch each. The header has the storage chip "pi settings.json", "Check for updates" and the amber "+". **Your skills** are rows with the scope chip,
  the description and `/skill:name`, "Add to composer", an edit pencil (the file editor) and the toggle; its "+" opens an inline row (name, For me / This project, Create and edit) that makes the folder from the template and opens the editor. **Your extensions and prompts** are the
  top-level files; the built-in ones have a disabled toggle.
  **Add a package** is a wizard (`.pk-wf` `.win.wide`) with a `join` of three radio buttons in its head (Browse / From git / From a folder). Browse has the search field and a "what it contains" select above `pk-choices.one` results (name with `ships with pi-kit` / `installed`
  / "skills only" chips, a line of what it adds, downloads, "updated 4 days ago", licence). Step 2 shows the name and version, "by … · repository · licence", a `.box` "What it adds" (`kv`: Extensions, Skills, Prompts, Themes with their names, and **Will run** with the exact command in mono),
  the README as plain text in a 160px scroll box, and the switch "Enable for every project" (off installs for this project only: `pi install -l`). Install runs pi's package manager, reloads the idle open threads and closes the wizard; the row is in the list.
- **Tooltips** (`pkTip`) `[pkTip]="'Sign out'"` replaces `title=` everywhere in the settings libraries. One bubble: base-content on base-100 text, 12/16, 4px 8px padding, 6px radius, max 280 wide, an arrow 5px. It appears **400ms** after the pointer enters or after
  **keyboard** focus (a focus that a click caused shows nothing), fades 120ms, sits **above** the button, below it when there is no room, aligned to the button's edge when it is too near the side of the window; the arrow keeps pointing at the middle of the button.
  It is rendered in the CDK overlay, so a group's `overflow: hidden` cannot cut it (`.pk-tt`; the overlay stylesheet is imported in `styles.css`). **Escape** hides it and that Escape goes no further (the dialog stays); a click, a key press or leaving hide it too;
  a touch pointer never shows one. The button is described by the bubble while it shows (`aria-describedby`); an icon-only button still has its own `aria-label`. Wording: the imperative ("Sign out", "Edit", "Reveal in Finder"), the shortcut in
  parentheses where there is one ("Close (Esc)"), a storage chip's tip is the file it names, a disabled button keeps its reason as the tip (on a wrapper `span`, because a disabled button receives no pointer events).

## Brand

- **Mark:** the πk ligature — pi's π whose right leg is the stem of a k, the k's two arms reaching out; the
  name "pi-kit" as one shape — cut into sixteen triangular facets, lit from the top-left: warm golds
  (`#fbe3a0` → `#a06f28`), amber-orange (`#e2893f`) and copper (`#c46b3a`) on the k's arms, the folds a hairline of
  light (`rgb(255 255 255 / .22)`). Masters in `libs/shared/design-system/src/brand/`: `mark.svg` (one colour via
  `currentColor`, the facets kept by `fill-opacity`, for chrome: `--color-primary`), `mark-gold.svg` (the colours with
  a 1px drop shadow and a soft amber glow, for the splash, README and about), `wordmark.svg` (mark + "pi-kit" in
  IBM Plex Sans 600, the hyphen at weight 400 and muted). Minimum size 16px; at 32 and below the facets merge into
  one shape, which is fine.
- **App icon:** `apps/desktop/build/icon.svg`, a 1024 rounded square (radius 22 %) in a `#2d3038 → #14161a`
  gradient with a faint amber radial glow at the top, a `#3d414b` rim and a top sheen, the faceted mark embossed
  on it. `icon.png`, the 16–512 set, the favicon and the doc images are rendered from the SVG masters with
  `rsvg-convert` and committed; electron-builder makes `.icns` and `.ico` from `icon.png`.
- **Splash:** `apps/desktop/src/splash.html`, 380 × 240, frameless, on `#141414` with the radial glow, the
  88px faceted mark, "pi-kit", one status line ("Starting the backend…", "pi is ready. Opening…"), the credit
  "Built by Soverius.AI GmbH" at the foot and a 2px amber sweep along the bottom edge (still under
  reduced motion). It closes when the main window has painted.
- **Credit:** "Built by Soverius.AI GmbH" appears on the splash, in the About panel (macOS app menu, with
  the copyright line) and in the README; nowhere else in the chrome.

- **Projects** **Settings › Projects** is a list page like Providers: a group **Projects** whose rows are `pk-item.open`: the folder tile, the name with its **trust chip**
  (trusted `ok`, not trusted `err`, waiting `warn`, nothing to trust `off`), the branch chip (`off`; "not git" for a folder that is not a repository, "hidden" for a project the sidebar does not list, drawn at 60 %), one detail line
  (the path in mono with the full path as its tip, then "31 threads · 2 worktrees · starts in a worktree · setup Node", or "4 project resources not loaded" while trust waits) and a chevron button at the right. The whole row opens the
  project's page; the rows are draggable (a 14px grip that appears on hover, the row at 50 % while it is dragged, a 2px amber line above the row it would land before) and **Alt+↑ / Alt+↓ on the chevron** moves one place, for the keyboard.
  The amber "+" adds a folder (the desktop app's picker; a browser types the path in a row that opens under the header). Under the list the group **Defaults for every project** (trust for new folders, worktree folder, new threads start), in the control column.
  - **A project's page** (`.pk-detail`) slides in from the right over 160ms (`pk-detail-in`; 16px and a fade) and slides out on Back (`pk-detail-out`); under the 120ms of a section it is the one place that moves sideways. It starts with the **breadcrumb**
    (`.pk-path`: 13/18 muted, "Projects › pi-kit", the first word is the Back button; a `div` with `role="navigation"`, because `.pk-settings nav` is the side navigation), then the title (the focus goes to it, so Esc and Tab begin there), the path in mono and the trust and
    branch chips, then groups in this order: **Trust** (Run project resources: "Review resources…" ghost button and the switch), **New threads** (Start as a join Local | Worktree | Ask; Local: switching branches), **Worktrees** (Folder, Cut from, Carry
    uncommitted changes, Branch, Branch prefix while the branch is named, Remove the folder), **Setup scripts**, **Open worktrees**, **Sidebar** (Show in the sidebar, Forget this project). A folder that is not a repository has Trust and Sidebar and one group
    that says why the rest is missing. **Esc** goes back before it closes Settings, and the nav tab of the open section leads back to its list. A text field saves when it loses the focus, a select, a join and a switch at once, and only the fields that changed are sent.
  - **Setup scripts** are `pk-item` rows with a terminal glyph, the name with a `default` chip on the first (and a `suggested` chip while the script is the one the lockfile suggests and nothing is saved), the command in mono and "copies .env.local", and the icon
    actions Make default (a star, not on the first), Edit and Remove. Editing opens a `pk-form` under the row (`.extra`, 160ms): Name, Command (mono), Files to copy (a mono textarea, one path per line), a hint under each, an error line, **Cancel** and **Save script**;
    a new script's form opens under the list. The list is saved whole.
  - **Open worktrees** are `pk-item` rows with a branch glyph, the branch (mono; "detached" while it has none) with the thread's state chip (running `ok`, waiting `warn`, merged or pull request `info`, idle `off`), the thread's title, "3 commits ahead of main" and
    the folder (mono, on its own line), and three ghost text buttons: **Hand off to local**, **Merge back…**, **Remove folder** (off while a run goes, with the reason as the tip). Remove folder asks in a line under the row ("This cannot be undone"); a refusal
    ("2 uncommitted changes") replaces the question and the button becomes **Remove anyway**. Hand off and Merge back open the thread's own dialogs above Settings.
  - **Forget this project** asks in the row ("Forget pi-kit", Cancel); the project leaves the list and the sidebar, its threads and files stay, and opening the folder again brings it back.
  - **Alignment**: in every `.pk-group` row of every section the control is in `ctl ctl-w`, one column of `--pk-ctl-w` (320px), so the controls of a section share a left edge. A select or an input fills the column; a toggle, a button or a
    join sits at its right end; icon actions right-align in it; two controls in one row (the release select and its "Use it") share the width. A control carries **no width of its own**: no `w-36`, `w-44`, `w-64`, `w-72` (`w-full`, and the `min-w-`/`max-w-` of a flex line
    in a dialog, are fine). Labels, hints and units are never inside the control: a row says its name and hint on the left and the unit in the hint ("0 means never"). Where one thing needs several fields (a pattern is a name and an expression) the column stacks them (`flex-col`)
    with the button under them at its right. Under 768px the column drops under the label and takes the row's width. The rule is a unit test (`libs/settings/util` `alignment.spec.ts`) that reads the settings templates and fails with the file and line.

## Motion

Only in response to an action: menus and drawers 120ms ease-out (the model picker pops in 120ms: 4px rise and fade), expanding
rows 160ms. The streaming caret blinks, and the run ring's dot orbits while a run goes; nothing else animates on its own. The
Where row: the values of its three slots open over 160ms when the mode changes, its menus over 120ms (a 4px rise). The sidebar:
a "Needs you" item slides in from the left and out to the right in 160ms; a band's chevron turns 120ms; a row's background
eases 120ms. `prefers-reduced-motion` turns it all off.

The Settings transitions, all in response to the click that causes them: a **section** cross-fades in 120ms ease-out with a 4px rise (`pk-pane-in`, on `.page`); a **dialog**'s backdrop fades and its window scales
from .98, 120ms (`pk-fade-in`, `pk-win-in`, on `.pk-settings` and `.pk-wf`); a **wizard step** slides 24px in the direction of travel, 160ms (`.wstep`, with `.back` going back); an **expanding row** (a form opening under a radio, the
tool list, the redirect-URL field) 160ms (`.pk-expand`); a **detail page** slides in from the right, 160ms (`pk-detail-in`), and out again on Back (`pk-detail-out`); the "Saved" tick fades in 120ms; a **tooltip** fades 120ms after its 400ms wait (see Tooltips). `prefers-reduced-motion: reduce` removes
every animation and transition listed here.

## Secrets

A credential is entered once, in a password field with no reveal toggle, inside a step of a
workflow (provider → get a key → paste → validate → done), never in an inline field on a list or
a settings row. After that the UI shows only the provider, the last four characters, where it is
stored and when it was added. Nothing renders, logs or copies a full key, including error messages
and screenshots.

Where it is stored is one of five words, the same everywhere a credential is listed (`credentialStoreText`):
**keychain** (with the system's name, "macOS Keychain"; `auth.json` holds only the command that prints the key),
**auth.json, plain text** (an API key pi keeps in its own 0600 file: a warning chip, and a prompt to move it
when a keychain exists), **auth.json, refreshed by pi** (an OAuth token), **a command that prints it**, and
**environment variable**. A machine with no credential store says so in a warning group on Settings › Providers
and in Advanced, never silently. The one secret the app shows is the database's recovery key: in a modal, once,
selectable and copyable, with "I have saved it" as the only way out; afterwards its button reads "Recovery key shown".

Redaction (`[redacted openai key …a1b2]`) is text, not a colour: a key shape in a transcript, a tool's output or an
export is replaced by the kind of key and its last four characters, so two different keys can be told apart; the
transcript marks nothing else and the original is not kept by pi-kit.

## Writing

Buttons say what happens: "Allow", "Deny", "Stop", "Send", "Go here", "Fork to new thread".
Empty states tell the next step ("No threads in this folder yet. Start one with ⌘N."). Errors say
what failed and what to do. Meta text is a short phrase, not a string of items joined by dots.
