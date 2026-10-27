# ADR-0014: Files panel shows git status badges and refreshes live

Status: Accepted
Date: 2026-10-16

## Context

The Files panel was a lazy tree with drag to the composer and nothing that told a developer what changed, and it did not notice edits made outside the app.
The Files and Changes panels need a live view of the workspace folder, which means one file watcher, a debounced stream and git calls that do not fight the user's own git.

## Decision

- **Git badges.** `GET /api/workspaces/:id/status?thread=<id>` returns `{ git, entries, thread, truncated? }` from `git status --porcelain=v1 -z --untracked-files=all --find-renames`, parsed by `parseStatusZ` in `libs/protocol/src/file-badges.ts`, shared with the renderer. The Changes panel keeps its own `--no-renames` list; the two never mix.
- Six one-letter badges: `M` modified, `A` added, `D` deleted, `U` untracked, `C` conflict, `R` renamed (origin in the tooltip); a file changed in index and tree is one badge. A folder shows a dot in its most severe badge's colour (`C` > `D` > `M` > `R` > `A` > `U`). A deleted file keeps its row, struck through. `FileNode` carries `size`, `mtime` and `missing`; size and time show at 1440 px and wider.
- **Show ignored** is `?ignored=1` on the tree endpoint (`git ls-files --others --ignored --exclude-standard --directory`; without git, what the walk skips), drawn at half opacity, remembered in `localStorage` as a per-viewer convenience. Empty folders are listed although no git list names them.
- **"Changed in this thread"** is a `π` marker before the badge, not a git badge: the files of successful `edit` / `write` calls on the active branch whose content still differs from `change_baselines`, the content captured before each file's first edit.
- **Live refresh.** chokidar 4 (CommonJS, pinned). `WatchService` keeps one reference-counted watcher per workspace folder; `watchIgnored` skips `node_modules`, build output and the root `.gitignore`'s names, and reduces `.git` to `index`, `HEAD`, `logs/HEAD`, `refs/heads/**` and `packed-refs`. `Batcher` sends a batch 300 ms after the last event and at most 1.5 s after the first, at most 200 paths, then `overflow`.
- Transport is newline-delimited JSON on `GET /api/workspaces/:id/watch` (`ready`, `change`, `ping`) under the per-launch loopback token's bearer guard. The renderer's `WorkspaceWatch` holds one stream for Files and Changes together and 3 s after the last panel lets go; `FilesService` forgets its cache before each `change`.
- **`GIT_OPTIONAL_LOCKS=0`** on every git call of the panels, so `git status` neither takes `index.lock` nor rewrites `.git/index` into a watcher loop.
- **Context menu** (`pk-context-menu` in `libs/ui`): Open in editor, Reveal (`reveal-path` through the desktop bridge, a toast in a browser), Copy path, Copy relative path, Add to message (`UiBus.insertIntoComposer`), New file, New folder, Rename, Delete, and for a badged file Open diff (review mode via `ReviewState.openFile`) and Revert (the Changes panel's working-tree revert after confirmation; absent without a thread).
- File operations are `POST /api/workspaces/:id/fs/{create,rename,delete}` (`FsService`): every path through `insideWorkspace`, `.git` never touched, nothing overwritten (409), delete only with `confirm: true`.
- **Keyboard**: a roving `treeitem` tree with arrows, Home, End, type-ahead, F2 rename, Delete, Enter (diff for a changed file, `@path` otherwise), and ⌘⇧F to open the panel and focus the filter (`UiBus.filesFilter`).

## Consequences

- The watcher holds file handles while a panel is open and 3 s after; nested `.gitignore` files are not read, so a folder ignored only there is still watched.
- The status call runs `git status` and rebuilds "This thread" on every batch, which is the Changes panel's cost per refresh.
- "Reveal in Finder" is not localised; the clipboard needs a secure context (localhost and the desktop app are).
- In a git worktree `.git` is a file, so index and HEAD changes are not watched and badges follow only file edits.
