# ADR-0014: Files panel shows git status badges and refreshes live

Status: Accepted
Date: 2026-10-16

## Context

The Files panel was a lazy tree with drag to the composer and nothing that told a developer what changed, and it did not notice edits made outside the app.
The Files and Changes panels share refresh notifications and git calls that do not fight the user's own git. The current implementation publishes run and HEAD changes rather than watching every filesystem edit.

## Decision

- **Git badges.** `GET /api/workspaces/:id/status?thread=<id>` returns `{ git, entries, thread, truncated? }` from `git status --porcelain=v1 -z --untracked-files=all --find-renames`, parsed by `parseStatusZ` in `libs/shared/protocol/src/file-badges.ts`, shared with the renderer. The Changes panel keeps its own `--no-renames` list; the two never mix.
- Six one-letter badges: `M` modified, `A` added, `D` deleted, `U` untracked, `C` conflict, `R` renamed (origin in the tooltip); a file changed in index and tree is one badge. A folder shows a dot in its most severe badge's colour (`C` > `D` > `M` > `R` > `A` > `U`). A deleted file keeps its row, struck through. `FileNode` carries `size`, `mtime` and `missing`; size and time show at 1440 px and wider.
- **Show ignored** is `?ignored=1` on the tree endpoint (`git ls-files --others --ignored --exclude-standard --directory`; without git, what the walk skips), drawn at half opacity, remembered in UI storage (the desktop UI file or browser `localStorage`) as a per-viewer convenience. Empty folders are listed although no git list names them.
- **"Changed in this thread"** is a `π` marker before the badge, not a git badge: files attributed to the thread by run snapshots whose content still differs from their earliest before-snapshot.
- **Live refresh.** `FolderChangesService` distributes batches from run snapshots and HEAD-change detection. It does not watch or poll the folder itself. A batch carries up to 200 paths, `overflow` and `headMoved`.
- Transport is newline-delimited JSON on `GET /api/workspaces/:id/watch` (`ready`, `change`, `ping`) under the per-launch loopback token's bearer guard. The renderer's `ThreadsStore` shares one stream between Files and Changes, keeping it for 3 s after the last panel lets go. Reconnection and window focus also trigger a refresh; `FilesService` invalidates its cache on folder batches.
- **`GIT_OPTIONAL_LOCKS=0`** on every git call of the panels, so `git status` neither takes `index.lock` nor rewrites `.git/index` into a watcher loop.
- **Context menu** (`pk-context-menu` in `libs/shared/ui`): Open in editor, Reveal (`reveal-path` through the service-host and desktop bridge, a toast in a browser), Copy path, Copy relative path, Add to message (`UiStore.insertIntoComposer`), New file, New folder, Rename, Delete, and for a badged file Open diff (review mode via `ChangesStore.openFile`) and Revert (the Changes panel's working-tree revert after confirmation; absent without a thread).
- File operations are `POST /api/workspaces/:id/fs/{create,rename,delete}` (`FsService`): every path through `insideWorkspace`, `.git` never touched, nothing overwritten (409), delete only with `confirm: true`.
- **Keyboard**: a roving `treeitem` tree with arrows, Home, End, type-ahead, F2 rename, Delete, Enter (diff for a changed file, `@path` otherwise), and ⌘⇧F to open the panel and focus the filter (`UiStore.filesFilter`).

## Consequences

- External filesystem edits do not produce per-file watcher events. Returning focus, reopening the stream or using Refresh rereads the folder.
- Refreshing badges runs `git status` and reads the thread's snapshot-derived changes.
- Clipboard access needs a secure context (localhost and the desktop app qualify).
