---
title: Thread protection
---

# Thread protection

Every thread has its own execution-protection mode. **Bypass is the default on macOS, Linux, and Windows** and preserves existing host execution. Protection uses only Anthropic Sandbox Runtime (SRT); no container, cloud service, or content-filtering service is enabled.

## Choose a mode

The composer has a **lock icon** beside the model and effort controls. An open lock means Bypass; a closed lock means Sandboxed. An amber warning marker means the effective state needs attention. Open the shared design-system popover to choose a mode, inspect status/recovery details, or refresh status. Changing modes requires explicit confirmation and an idle thread without active background agents.

- **Bypass:** existing host-backed tools and workflow permissions. No SRT worker, proxy or dependency check starts for this mode.
- **Sandboxed:** this thread's file, search and shell tools use its own SRT supervisor and restricted worker. Other threads, including threads in the same folder, keep their own modes and resources.

The icon shows the **mode**, green while the sandbox runs and a spinner while it starts; its tooltip and popover show the state of the sandbox: **starts before the next run**, **starting**, **active**, **experimental** (Windows), **unavailable**, **needs setup** (Linux) or **recovery required**. Unavailable and recovery required never mean Bypass: tools are blocked, and nothing runs on the host instead. A sandbox that failed to start cleanly is tried again on the next run.

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
| Linux | `bubblewrap` and `socat` (pi-kit brings its own ripgrep), and user namespaces with capabilities; on Ubuntu 24.04 and later a one-time setup (below). Tested on Ubuntu 26.04 arm64 |
| Windows | A Windows build with MXC BaseContainers (SRT's experimental `mxc` backend), and explicit experimental acceptance. No machine setup or administrator prompt. Tested on Windows 11 arm64; x64 qualification remains outstanding |

### Linux

Ubuntu 24.04 and later run whatever `/usr/bin/bwrap` starts without capabilities (the `bwrap-userns-restrict` AppArmor profile), and the sandbox's seccomp helper needs them, so a Sandboxed thread there shows **needs setup**. Choose **Set up Linux sandbox** in its protection popover: Ubuntu asks for your password once, and pi-kit installs its own copy of bubblewrap at `/usr/local/libexec/pi-kit/bwrap` with an AppArmor profile, `/etc/apparmor.d/pi-kit-bwrap`, that lets it create user namespaces. pi-kit uses that copy wherever it exists; Ubuntu's own setting for unprivileged user namespaces stays as it is. In a browser the popover points to the app, since only the app on that computer can ask for the password. Other distributions use the system's `bubblewrap` and need no setup.

To set it up by hand, or remove it:

```bash
sudo install -D -m 0755 /usr/bin/bwrap /usr/local/libexec/pi-kit/bwrap
sudo tee /etc/apparmor.d/pi-kit-bwrap >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile pi-kit-bwrap /usr/local/libexec/pi-kit/bwrap flags=(unconfined) {
  userns,

  include if exists <local/pi-kit-bwrap>
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/pi-kit-bwrap

# removal
sudo apparmor_parser -R /etc/apparmor.d/pi-kit-bwrap
sudo rm /etc/apparmor.d/pi-kit-bwrap /usr/local/libexec/pi-kit/bwrap
```

### Windows

On Windows the sandbox is an MXC BaseContainer: commands run as you, in a container that the operating system confines per command. Nothing is installed on the machine. A Windows build without BaseContainers shows the sandbox as **unavailable**, and nothing runs on the host instead.

The sandbox writes only in the thread's workspace and its own temporary folder, and reaches no network. It reads the system drive, but not your profile: when the workspace is inside the profile, every entry on the way to it is unreadable except the folders that lead there, whose names (not their contents) it can list. An entry created in one of those folders while the sandbox runs is not covered until the next start. Files and folders Windows holds open exclusively, such as the registry hive, are left out; nothing can read them meanwhile.

The MXC backend is experimental. Sandboxed programs can open windows on the desktop; programs built on MSYS2, Git Bash included, do not start; `%TEMP%` is fresh for every command. It does **not** guarantee hostile-code network containment or read isolation between workspaces outside your profile. Strict requirements that the backend cannot enforce must be refused, and a failure never falls back to the host.

POSIX cancellation owns process groups; it does not provide a race-free termination guarantee for hostile daemons that deliberately detach/reparent. Unsupported quotas and generic command replay/reattachment are not provided.
