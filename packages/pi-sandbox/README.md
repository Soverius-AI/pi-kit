# @pi-kit/sandbox

Runs pi's file, search and shell tools inside an [SRT](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)
(0.0.81) sandbox. Each sandbox is one trusted supervisor process plus one OS-confined worker. When the sandbox is
unavailable, requests fail; nothing ever falls back to the host.

Nothing starts until `Sandbox.create` is called: importing the package does not load SRT, probe dependencies or
spawn processes.

## Build and test

```sh
pnpm exec nx build pi-sandbox                                 # esbuild bundle and declarations -> dist/
pnpm exec nx test pi-sandbox                                  # unit, IPC, worker filesystem and durable transport tests
PI_SANDBOX_SMOKE=1 pnpm exec nx test pi-sandbox --skip-nx-cache  # also runs the real SRT checks on this machine
```

On Windows the smoke tests also need `PI_SANDBOX_WINDOWS_ACCEPT=1`.

## Core

```ts
import { Sandbox } from '@pi-kit/sandbox/core';

const client = await Sandbox.create({
  cwd: '/absolute/project',
  protectedPaths: ['/absolute/private/state'],
  experimentalWindowsAccepted: false, // required (true) on native Windows
});
try {
  await client.request('writeFile', ['/absolute/project/out', Buffer.from('ok')]);
  await client.exec('printf hello', '/absolute/project', { onData: (b) => process.stdout.write(b), timeout: 30 });
} finally {
  await client.close();
}
```

- `client.state` is `active`, `unavailable` or `closed`, and `client.reason` explains a failure. A crashed worker or
  supervisor makes the client `unavailable` and rejects all pending and later work. Interrupted mutations are
  uncertain, so don't replay them automatically.
- `close()` is idempotent. It resolves once the supervisor confirms that the worker exited, SRT was reset and the
  scope temp directory was retired. It rejects with `TEARDOWN_UNCONFIRMED` (or the reported error) otherwise.
- If `Sandbox.create` fails, the error has `cleanupConfirmed: true` only when teardown was acknowledged (or nothing
  was started).
- `Sandbox.setupWindows()` runs SRT's machine-wide
  Windows install (`skipProfileGrant: true`, no loopback). It is a separate, explicit step.

### Requests

| Operation | Arguments → result |
|---|---|
| `readFile` | `[path, {length?}?]` → Buffer. Regular files only, up to 4 MiB; `length` reads only that many leading bytes |
| `writeFile` | `[path, stringOrBytes, {encoding?, mode?, flag?}?]` → void. Regular files only; flags `w`, `wx`, `a`, `ax` |
| `mkdir` | `[path, {recursive?, mode?}?]` → void |
| `access` | `[path, mode?]` → void |
| `stat` | `[path]` → numeric metadata plus `isFile`, `isDirectory`, `isSymbolicLink` (follows links) |
| `readdir` | `[path]` → string[], at most 50,000 entries |
| `artifact.write` | `[Buffer]` → path of a worker-private file (≤ 4 MiB), deleted when the sandbox closes |
| `durable.*` | the durable adapter's allowlisted methods (below) |

Relative paths resolve against the workspace. Your spelling of the workspace (e.g. `/var/...` on macOS) maps onto its
canonical path. Access itself is decided by the OS policy, not by path checks in this package.

## pi adapter

```ts
import * as pi from '@earendil-works/pi-coding-agent';
import { PiSandbox } from '@pi-kit/sandbox/pi';

const options = { client, cwd, assertCurrent: () => verifyOwnerStillAdmitted() };
for (const tool of PiSandbox.toolDefinitions(pi, options)) api.registerTool(tool);
api.on('user_bash', () => ({ operations: PiSandbox.operations(options).bash }));
```

`toolDefinitions` returns `read`, `write`, `edit`, `bash`, `ls`, `find` and `grep`, plus `powershell` on Windows. `ls`,
`find` and `grep` are off unless pi's `defaultTools` setting names them, as in pi. pi's grep always runs ripgrep where
it is called, so the worker bundles pi's own grep module and the host's grep only forwards the call: the search, its
limits and its output are pi's.
It reuses pi's schemas and renderers. `assertCurrent` runs before every tool and every request. A few pieces still
run on the host:

- pi's read tool probes path variants on the host before the confined read, so it can reveal whether a host file
  exists.
- Image decoding and resizing run in the host pi.
- Edit's live preview, which would read the host file, is disabled. The rendering of completed edits is kept.
- `find` and `grep` run `rg` inside the sandbox, so `rg` must be on the sandbox `PATH` (Homebrew, `/usr/bin` or
  `/usr/local/bin`; not yet on Windows).
- Shell and search output is capped at 4 MiB. Beyond that the command is cancelled with `OUTPUT_LIMIT`.
  `structuredContent.output` follows pi's 1 MiB head/tail cap.

## Durable adapter

```ts
import { DurableSandbox } from '@pi-kit/sandbox/durable';

const env = DurableSandbox.environment(client, { cwd, namespaceId: 'node:local', release: () => client.close() });
```

This is a pi-durable `ExecutionEnv` whose calls are RPCs to a `NodeExecutionEnv` inside the worker. Specifics:

- `watch` returns `not_supported`, and there is no `listFiles`.
- Content operations on FIFOs and devices return `invalid`.
- Command output is long-polled.
- With `inheritEnv: true`, a command inherits the worker's sanitized environment, never the backend's.
- `cleanup()` calls `release` once.

## Policy

- **Writes:** the workspace and one private temp directory. Within those, `node_modules`, `.env*`, the package, the
  Node directory and `protectedPaths` are write-denied. SRT additionally write-denies
  `.git/hooks`, `.git/config`, shell rc files and editor config directories.
- **Reads:** the workspace, the temp directory, the package and Node directories, and system/toolchain paths
  (`/usr`, `/bin`, `/lib*`, `/System`, `/Library`, `/opt/homebrew`, `/dev`, `/proc`, `/etc`). Those system paths are
  readable but not guaranteed to be free of secrets.
- **Denied reads:** `.env`/`.env.*` at any depth, `protectedPaths` and common credential locations (`~/.ssh`, `~/.aws`,
  `~/.config`, `~/.pi`, `~/.npmrc`, `~/Library`, …). These use SRT credential denies, which take precedence over
  `allowRead`.
- **Refused workspaces:** filesystem roots, and the home directory or any of its ancestors.
- **Network:** denied (empty allowlist, no local binding, no Unix sockets).
- **Environment:** only `LANG`, `LC_*`, `TZ`, `TERM` and `COLORTERM` cross from the caller. PATH is fixed, and HOME and
  TMPDIR point at the temp directory. Shells run without profiles or rc files.

## Limits

- This is not a security-qualified isolation product. Host extensions, renderers and model calls stay outside the
  sandbox.
- Cancellation kills the command's process group, and a shell's background jobs die with it. A process that leaves
  its group (`setsid`) can outlive teardown, which is why a closed client is not proof that nothing survived.
- There are no CPU, memory, disk or process quotas, and no exactly-once mutations.
- Hard links, rename races and files created after startup are not systematically tested.
- Only macOS arm64 (Node 24) has been exercised.
- Windows is experimental: network and cross-workspace read containment are not guaranteed. Token impersonation,
  SMB, WSL and system DNS bypass filtering. Account, ACL and WFP setup and teardown are untested. Creation refuses to
  start without `experimentalWindowsAccepted`, or when a broad profile read grant already exists.

## Bundle

`nx build pi-sandbox` bundles each entry (`core`, `pi`, `durable`, `supervisor`, `worker`, `durable-worker`) with
esbuild, SRT and the pi-durable and chord code included. SRT's helper binaries for every target
(`apply-seccomp` for Linux x64/arm64, `srt-win.exe` for Windows x64/arm64, the Java proxy agent) are emitted by
esbuild under `dist/vendor/` and passed to SRT by path.

That default build serves every platform (development and tests). A release builds one bundle per target with
`PI_SANDBOX_TARGET=<platform>-<arch>` (for example `linux-x64`): `process.platform` and `process.arch` become
constants, so the bundle keeps only that target's SRT code and helper. `scripts/package-stage.mjs` does this for each
target straight into its staged backend.
