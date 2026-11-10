---
title: Thread protection
---

# Thread protection

Every thread has its own execution-protection mode. **Bypass is the default on macOS, Linux, and Windows** and preserves existing host execution. Protection uses only Anthropic Sandbox Runtime (SRT); no container, cloud service, or content-filtering service is enabled.

## Choose a mode

The composer has a **lock icon** beside the model and effort controls. An open lock means Bypass; a closed lock means Sandboxed. An amber warning marker means the effective state needs attention. Open the shared design-system popover to choose a mode, inspect status/recovery details, or refresh status. Changing modes requires explicit confirmation and an idle thread without active background agents.

- **Bypass:** existing host-backed tools and workflow permissions. No SRT worker, proxy, dependency check, or privileged setup starts for this mode.
- **Sandboxed:** this thread's file, search and shell tools use its own SRT supervisor and restricted worker. Other threads, including threads in the same folder, keep their own modes and resources.

The icon shows the **mode**; its tooltip and popover show the state of the sandbox: **starts before the next run**, **starting**, **active**, **experimental** (Windows), **unavailable**, **needs setup** (Windows) or **recovery required**. Unavailable and recovery required never mean Bypass: tools are blocked, and nothing runs on the host instead. A sandbox that failed to start cleanly is tried again on the next run.

Selecting Bypass for a protected thread is an explicit downgrade. The backend requires confirmation and confirmed cleanup before saving the downgrade. Backend authentication, renderer isolation, project trust, credential handling, and existing workflow checks remain enabled in both modes.

Remote browsers can inspect the mode but cannot change it. Protection changes are desktop/local owner operations, not model-callable grants.

## What the initial protected mode covers

- Built-in read, write, edit, `ls`, `find`, `grep` and shell tools, plus `!` and `!!` shell execution, use the restricted worker. `grep` is pi's own grep, run inside the worker, so it can only search what the sandbox may read.
- Workspace and private temporary/artifact writes are allowed, subject to protected-path denials. Toolchain/dependency trees are read-only.
- Credentials, private application state, sensitive workspace files such as `.env`, host control sockets, and inherited credential environment variables are restricted.
- Network access is denied by default. A network destination-grant UI is not yet implemented.
- Unsupported MCP transports, MCP configuration helpers, direct MCP App actions, browser/computer-use tools, and unreviewed host tool capabilities are refused rather than silently run outside protection.

Sandboxing covers tools, not extensions: extensions still initialize on the host and must be trusted. Image decoding and limited SDK path-existence probes are also host-side. Manual owner terminals and editors are not sandboxed agent tools. A Bypass thread still has host permissions: this feature is not mutually untrusted-user or multi-tenant isolation.

Read and output sizes are bounded; large-output artifacts belong to the worker lifetime. See `packages/pi-sandbox/README.md` for current bounds and search differences. Arbitrary code is not guaranteed safe, and sandboxing is not prompt-injection detection or complete data-loss prevention.

## Persistence and background agents

The backend stores the mode separately from transcript content. Reopening or navigating an older conversation branch cannot reset protection. Forked/cloned threads inherit the source mode but own new runtime resources.

Background agents persist their parent's protection decision before submission and use their own owned environments. `read-only`, `edit`, `isolated`, and “Allow all” remain workflow permissions and cannot widen the inherited sandbox boundary.

Protected durable environments support filesystem operations/readers and shell output/spill transport. Watchers and optional recursive listings currently return `not_supported`; they never fall back to the host.

A thread needs recovery when its sandbox did not confirm its shutdown: the app quit or crashed while the sandbox ran, or a shutdown or failed start could not confirm that its processes ended. **A restart alone does not prove that the old work stopped**, so the thread runs nothing until you confirm its recovery. Check that no command of that thread still runs (for example in Activity Monitor or `ps`), then choose a mode in the protection popover and tick the recovery confirmation. Deleting the thread also clears it.

A sandboxed background agent that a restart interrupted is held: its commands cannot be reattached or replayed, so it can only be stopped. Start a new agent for the remaining work.

## Platform setup and assurance

| Platform | Prerequisites and current assurance |
| --- | --- |
| macOS | Seatbelt/`sandbox-exec` and `ripgrep`; local arm64 smoke tests have run, but this is not a security certification |
| Linux | `bubblewrap`, `socat`, `ripgrep`, and usable namespace/seccomp primitives; native Linux qualification remains outstanding |
| Windows | Native SRT alpha helper, explicit experimental acceptance, and a one-time machine setup from the protection popover (**Set up Windows sandbox**). Native x64/arm64 execution qualification remains outstanding |

### Windows setup

SRT's Windows sandbox runs commands as a dedicated local account, so each machine needs a one-time setup. When a Sandboxed thread shows **needs setup**, choose **Set up Windows sandbox** in its protection popover and confirm. Windows asks for administrator permission once; the setup creates the `srt-sandbox` account and firewall (WFP) rules for it, then the thread's sandbox starts. The account and rules apply to the whole machine and are shared with other applications that use SRT, so uninstalling pi-kit does not remove them. Your user profile is not made readable to the sandbox. A later SRT release can ask for the setup again; the same action repeats it.

Native Windows has known network-filter bypasses and shared-account/persistent-grant read limitations. It does **not** guarantee hostile-code network containment or mutually untrusted workspace read isolation. Strict requirements that the backend cannot enforce must be refused. Setup does not grant broad profile reads by default, and cancellation never authorizes host fallback. Machine-wide setup/removal must be coordinated with other SRT applications.

POSIX cancellation owns process groups; it does not provide a race-free termination guarantee for hostile daemons that deliberately detach/reparent. Unsupported quotas and generic command replay/reattachment are not provided.
