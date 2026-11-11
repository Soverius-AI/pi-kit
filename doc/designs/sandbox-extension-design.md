# Plan: SRT-only sandbox extension for pi, pi-kit, and pi-durable

Date: 2026-11-06. Status: **initial implementation on `feat/thread-protection`; not security-qualified**. This document includes release gates and remaining work, not a claim that every planned capability is complete.

This plan supersedes the earlier two-runtime design. [Original security research](security-sandboxing-research.md) remains background information, not the active roadmap.

## Decision and scope

Build **`@pi-kit/sandbox`**, an ordinary, independently usable pi extension backed **only by Anthropic Sandbox Runtime (SRT)**. Put execution, filesystem routing, policy, and lifecycle logic in the package so pi-kit and pi-durable reuse it.

- **Extension first:** usable from native pi without pi-kit.
- **pi-durable supported:** a separate full `ExecutionEnv` adapter over the same SRT worker/session implementation.
- **Better pi-kit integration:** per-thread protection controls, enforced admission, background-agent inheritance, approvals, recovery, status, previews, and artifacts.
- **Independent protection for each thread; Bypass is the default on every platform.** Bypass preserves the current host-execution behavior. SRT protection is an explicit opt-in for that thread; once enabled, failures block execution rather than falling back to Bypass or the host.
- **Platforms in scope: macOS, Linux, and native Windows**, each with its own setup and qualification matrix. Windows uses SRT's **alpha** backend and requires a separate explicit experimental opt-in acknowledging known network and cross-scope read-isolation limitations. It is not presented as equivalent to the macOS/Linux profile.
- **No OpenShell, NVIDIA/NeMo integration, Docker requirement, cloud execution, WSL provisioning, or multi-provider abstraction.** Any later scope change needs a separate decision, not placeholder infrastructure now.

The first supported tier is **sandboxed tool execution with trusted host extensions**. Arbitrary host-loaded extension startup code is not contained. Whole-agent isolation is a separate, deferred project and must not be implied by an “Active” badge.

## Evidence baseline and limitations

The evaluation inspected repository-installed **pi and pi-durable 1.4.0** and published **`@anthropic-ai/sandbox-runtime@0.0.81`** declarations, JavaScript, and README. The downloaded npm tarball matched its published SHA-512 integrity value. This is the candidate pin for the implementation spike; recheck advisories and publishability before adopting it.

SRT is a **beta research preview**, not a production security certification. It uses macOS Seatbelt, Linux bubblewrap, or on Windows a dedicated account, restricted tokens, NTFS ACLs, and Windows Filtering Platform (WFP), plus filtering proxies. It wraps processes; it does not automatically restrict filesystem calls in the host pi process. Windows's documented residual bypasses remain limitations even if dependency checks succeed.

The initial implementation has passed local macOS arm64 SRT smoke tests and backend HTTP checks, including restricted filesystem/shell operations, environment filtering, independent owners, cancellation, and explicit downgrade consent. Unit/contract tests cover mode persistence, failure admission, durable transport, UI state, and packaging. Linux and native Windows workloads/installers have not been executed here; neither platform is security-qualified. No performance benchmark has been run. The remaining release gates below still apply. API features from the separately installed pi 1.5 documentation must not be assumed to exist in the repository's 1.4 baseline.

### Initial implementation boundaries

- `packages/pi-sandbox` provides the shared core, native pi adapter, private supervisor/worker, and optional durable adapter. pi-kit persists authoritative per-thread decisions and owner intents in host storage; its composer uses the shared design-system menu with Bypass as the default.
- Protected SDK `executeBash` calls receive explicit sandbox operations: the SDK method does not emit `user_bash` itself. The TUI hook alone is not sufficient for REST `!` execution.
- MCP transports/helpers, direct MCP App actions, and unreviewed host tools are blocked for protected threads rather than routed in this first implementation. Manual owner terminals/editors remain host-side capabilities outside agent-tool protection.
- Network access is denied; a destination-grant workflow is not implemented. Read/output sizes are bounded, search behavior has documented differences, and toolchain/dependency trees are read-only.
- Durable file readers and shell output/spill transport are implemented; watchers and optional recursive listings return typed `not_supported` errors. Interrupted protected agents and unresolved owner intents require review and are not automatically reattached or replayed. There is no automatic resource-recovery UI yet.
- POSIX process-group cancellation does not establish race-free containment of hostile descendants deliberately using `setsid`/reparenting. Host-loaded extensions, host image decoding, and limited SDK path-existence probes remain trusted; whole-agent isolation is not claimed.

See the [user guide](../docs/thread-protection.md) and package README for current behavior and limitations.

## Per-thread protection model

Protection is owned by a **thread**, not by the workspace, a conversation branch/leaf, the renderer, or the backend process. Two threads in the same project may use different modes without changing each other's execution configuration.

| Mode | Default | Execution behavior |
| --- | --- | --- |
| **Bypass** (`bypass`) | Yes, on macOS, Linux, and Windows | Current host-backed tools and existing workflow permissions. No SRT imports, dependency probes, supervisor/worker startup, proxy startup, or privileged setup is required |
| **Sandboxed** (`sandboxed`) | No; explicit thread-level opt-in | Tools use that thread's SRT policy and owned supervisor/worker. Missing enforcement blocks execution; unsupported capabilities are routed or refused |

These are protection modes, not a new collection of policy presets. The initial protected mode uses the single project-tools policy below. Windows additionally requires explicit experimental acceptance and retains its disclosed limitations.

### Ownership and persistence

- Persist a versioned thread-protection record in trusted host storage: thread ID, mode, effective policy reference/hash, generation, platform assurance/acceptance, and recovery state. A protected run and each background-agent binding retain the effective snapshot they were admitted under.
- New and legacy threads without a protection decision start in **Bypass**, preserving current behavior. Missing/corrupt metadata for an already protected run is a recovery error, not evidence that it was a legacy Bypass thread.
- User/project preferences may explicitly seed the mode for **new threads only**; the shipped default remains Bypass. Changing a preference never retargets existing threads or agents. A project's agent-writable files cannot enable, disable, or widen a thread's authoritative protection.
- Resume/reopen restores the thread's saved mode, policy authority, and recovery requirements. Navigating an older transcript leaf cannot revert the current protection decision or restore revoked grants.
- Forking/cloning into a new thread creates an independent protection record and fresh runtime ownership, carrying the source thread's effective mode and capability ceiling unless the user explicitly changes it. It does not share live SRT resources or silently reset a protected fork to Bypass.
- Each background agent owns its own binding and inherits the parent thread's capability ceiling before submission. Changing the parent's mode never silently widens existing child bindings; existing workflow modes (`read-only`, `edit`, `isolated`) remain separate.

### Switching a thread's mode

Expose a protection selector in the thread/composer UI and retain equivalent native pi commands. Show the selected mode separately from runtime readiness. A user may explicitly switch a thread to Bypass; the model, repository configuration, and extension event bus cannot authorize that switch.

A mode or grant change waits for the affected thread's work to become idle, or explicitly stops and reconciles it first. Persist the approved transition before admitting work under a new generation. A downgrade to Bypass requires a warning that subsequent tools run with host permissions. Setup denial, a timeout, a crash, package removal, or a worker failure never counts as that approval. Do not automatically replay partially completed mutations after a switch.

Changing, closing, or recovering one thread must not reconfigure, adopt, or stop another thread's resources, even when they share a cwd. Bypass bypasses only the optional SRT layer: backend authentication, renderer isolation, project trust, credential handling, and existing workflow checks stay in place. This is independent per-thread execution policy, **not isolation from another Bypass thread or trusted extension running with the host user's privileges**.

## Architecture: one package, no vendor abstraction layer

```text
packages/pi-sandbox/                 # @pi-kit/sandbox
  package.json                      # pi.extensions; core/durable exports
  extensions/sandbox.ts             # standard pi commands, hooks, tool registration
  lib/core.ts                       # typed lifecycle/client API
  lib/{policy,protocol}.ts           # SRT policy and bounded IPC
  lib/supervisor.ts                  # trusted supervisor; only runtime SRT import
  lib/worker.ts                      # OS-restricted file/command worker
  lib/pi.ts                          # native pi tool operations
  lib/{durable,durable-worker}.ts    # typed ExecutionEnv facade and confined dispatch
  dist/                             # generated .js/.d.ts, not authored source
  tests/**/*.ts                     # strict operation/isolation/lifecycle tests
  project.json                      # native @nx/js:tsc build/check/test compilation
```

Compile strict `.ts` source to Node-consumable `.js` and generated `.d.ts` declarations using native Nx TypeScript targets, independent of pi's TypeScript extension loader. The package manifest's `type: module` preserves ESM. Backend staging depends on the Nx build/check graph and only copies output; package prepacking also uses those targets. Shipped helpers require no TypeScript compiler or runtime loader. Keep Nest, Angular, database access, and pi-kit's internal types outside the package. Keep pi-durable adapter imports out of the basic pi entry point; declare appropriate optional host peers. Load SRT lazily when needed, not by starting processes or proxies in the extension factory.

### Why a supervisor is required

The published SRT package exports a **process-global mutable `SandboxManager`** with shared configuration, proxies, initialization, and reset state. Importing it once into pi-kit's multi-session backend would let one scope's reconfiguration/shutdown interfere with another.

```text
Native pi extension / pi-kit host / durable ExecutionEnv
  -> private trusted supervisor, one per policy scope
     -> one SRT manager with an immutable policy generation
        -> OS-restricted file/command worker
           -> allowed files and restricted descendant commands
```

The supervisor runs outside confinement and owns SRT's proxies and process lifecycle. Filesystem requests execute in the **restricted worker**, never through host `fs` calls after a lexical path check. The worker must not inherit the supervisor control endpoint, backend bearer token, credential access, or unrelated descriptors.

Each protected thread and background-agent binding owns a separate supervisor and SRT manager. Bypass threads own no SRT resources. Do not pool supervisors or share live policy/runtime state between threads, even when cwd and policy match. Construct runtime dependencies per extension-factory invocation/binding, not at module scope: pi may cache and reuse extension factories. Avoid process-global handoff slots and mutations to `process.env`; cancellation, reload, reset, and cleanup remain owner-scoped.

On Windows, separate supervisors prevent SRT manager-state collisions but **do not create separate Windows sandbox accounts or WFP installations**. Machine-wide account/ACL state requires additional coordination and explicit capability limitations. A thread cannot silently change shared setup or claim read/network isolation that the backend cannot provide.

### Small shared contracts

Use concrete SRT session/binding APIs, not a provider registry. Proposed names, not existing upstream exports:

- `probeSrt()` reports support, dependencies, and restrictions that cannot be enforced.
- `createSandbox(policy, owner)` starts a supervisor and constrained worker.
- `reconcileSandbox(binding)` determines whether the owned resource/generation is still valid.
- `SandboxClient` supplies file operations, owned commands, cancellation, artifacts, and status.
- `closeClient()` releases a connection; `stopCommand()` cancels one operation; owner shutdown terminates the scope. They are not interchangeable.

For Sandboxed mode, persist a versioned binding containing thread/agent ID, protection mode, policy hash/snapshot reference, SRT version, owner/epoch, resource ID, generation, namespace ID, cwd/path mapping, assurance level/accepted experimental limitations, and recovery state. On Windows, also record the helper/install generation and relevant setup fingerprint, but never the sandbox account password. Do not persist credentials, proxy tokens, or live PID-only identity as authoritative state.

The protocol needs bounded binary-safe frames, backpressure, typed errors, per-operation IDs, and handle lifetime. Shell output is framed data and cannot impersonate a control message. Expose no generic privileged evaluation or host filesystem escape hatch.

## Policy and opt-in behavior

The following rules apply only to a thread explicitly using **Sandboxed** mode. Bypass keeps the existing execution path unchanged, including when SRT is absent or unsupported. Implement one well-defined **project-tools policy** rather than many policy presets initially. Keep its requested rules separate from each platform's verified guarantees. Windows alpha has an explicit experimental assurance level; a caller requiring strict network or cross-scope read isolation must be rejected there, not silently downgraded:

- Read/write only approved workspace resources, required read-only toolchain/system resources, and scope-private temporary/artifact locations.
- Explicit denials for credentials, private app/session data, host control sockets, and selected sensitive workspace files such as `.env`. A workspace grant does not make all its contents safe.
- Default network deny, with an explicit approved destination/port list. No broad localhost/private-network grant merely to support previews.
- A sanitized environment, retaining only required toolchain variables and SRT-generated proxy settings. Review shell startup and dynamic loader variables such as `BASH_ENV`, `NODE_OPTIONS`, and language equivalents.
- Required primitives must exist; never enable weaker isolation or ignore unsupported restrictions just to start the worker.

SRT reads are broadly allowed by default, so the compiler must generate explicit restrictions and test their precedence. Policy files and effective grants live in protected host configuration, not agent-writable project files. Project configuration may suggest a policy but cannot widen it without explicit approval.

The host advertises only limits it can enforce. SRT is not a portable CPU/memory/process-quota solution; required unsupported quotas reject the profile instead of appearing active.

Keep the first implementation's network policy fixed per generation. Policy changes require explicit user/admin approval and controlled generation replacement. Handle existing commands before replacing a generation; open descriptors and already-performed side effects cannot be retroactively revoked. Do not automatically rerun mutating commands after granting access.

Noninteractive runs restore their saved thread-protection mode. A fresh run with no protection decision uses Bypass; a protected run uses a preapproved profile and denies new grants. Windows additionally needs a previously accepted experimental assurance level; headless execution cannot accept it on the user's behalf. Missing package, unsupported platform/architecture, missing dependency, startup failure, stale binding, or unavailable worker blocks an opted-in run. Bypass is an explicit mode, never a failure fallback.

## Included Windows workstream

Native Windows is part of phases 1–3, **not deferred to a different runtime**. Qualify x64 and arm64 separately using SRT's bundled `srt-win.exe`; ship those assets intact in the package and pi-kit's desktop build. Do not assume a JavaScript-only bundle includes the helper.

### Setup, diagnostics, and removal

- Add `/sandbox setup` on Windows and equivalent pi-kit setup/repair actions. Explain the dedicated account, machine-wide WFP filters, persistent ACL entries, one-time elevation, and experimental limitations before requesting UAC. No elevation during ordinary startup, no bypass when the user cancels.
- Use the pinned helper/runtime's install API or CLI with **`skipProfileGrant: true` / `--skip-profile-grant`**. Upstream's default install grants broad read access to the user's profile, including some package-feed configuration; do not apply that default silently. Grant only reviewed project/toolchain paths.
- Detect an already-installed broad profile grant and other applications' shared runtime state. Report the affected paths and provide explicit repair guidance; do not remove or change shared grants behind the user's back. Refuse a requested guarantee that this state cannot satisfy.
- `doctor` checks helper architecture/version/setup generation, account/WFP readiness, installed proxy range, loopback mode, profile warnings, kept grants, toolchain reachability, and residual verification results. A successful baseline probe must not hide known bypass warnings.
- Installation or loopback-mode changes are **machine-wide**. Stop/coordinate affected scopes before approved setup/upgrade/repair; never let workspace files request such changes. Preserve uninstall/forget guidance, including pending grants on disconnected volumes, and warn that removing shared setup affects other SRT applications.
- Setup, upgrade/downgrade, UAC denial, partial failure, removal, and reinstallation have their own tests. Normal sandbox shutdown does not mean all persistent Windows ACL grants were removed.

### Windows capability and security limits

| Concern | Planned behavior |
| --- | --- |
| Known token-impersonation/derived-token egress bypasses | Always disclose; label network filtering **not hostile-code containment**. Reject profiles requiring an unbypassable network boundary |
| SMB, WSL/service-mediated traffic, system DNS | Record as uncovered/residual channels; no claim that domain allowlists govern them. Reject UNC/network workspaces initially, but do not claim that this alone prevents service-mediated egress |
| Machine-wide account and kept project grants | Document that other sandbox sessions can read kept roots; separate supervisors do not fix it. No multi-user/multi-tenant or mutually untrusted workspace read-isolation guarantee; reject such requirements |
| Per-command read/write allows | Unsupported in the inspected Windows backend; use session-level grants and new generations rather than pretending per-command overrides work |
| Existing permissive NTFS ACLs | Probe relevant paths/volumes and surface ineffective restrictions; reject any required file protection we cannot establish |
| Shells | Explicitly qualify native PowerShell/direct argv; route Git Bash only when installed and verified. Never fall back to an unrestricted shell if one is unavailable |
| Schannel clients | `Invoke-WebRequest`, system curl, .NET/NuGet/winget and similar TLS clients are documented as incompatible under the restricted token; show an actionable unsupported-tool error, never rerun them on the host |
| Toolchain and paths | Prefer machine-wide tools or narrow read grants for per-user installations; qualify drive letters, case aliases, junctions/reparse points, long paths, Unicode, spaces, command quoting, and allowed local volumes |
| Process cancellation | Verify helper/job-object descendant termination and session-ended results; map them into the same command-uncertainty and durable cleanup contracts |
| Local previews | Keep broad `allowLocalBinding` off by default; it opens machine loopback, not just one preview. Any approved machine-wide change must display the expanded reachability; a narrow preview broker must not masquerade as stronger runtime confinement |

Windows status should say **“Experimental SRT restrictions — network and cross-scope read containment not guaranteed.”** Persist the explicit acceptance and visible limitations for native pi, pi-kit, and durable agents. Existing policy ceilings remain authoritative: experimental acceptance cannot satisfy a parent/admin requirement for a guarantee Windows does not provide.

## Phase 1 — reusable native pi extension

### Deliverables

1. Add `@pi-kit/sandbox` with independent install/package tests and a pinned SRT dependency.
2. Implement policy validation, dependency probes, supervisor ownership, constrained worker transport, and idempotent teardown.
3. Register same-name built-in tool definitions with routed operations: `read`, `write`, `edit`, `bash`, plus any enabled `grep`, `find`, `ls`, or platform shell. Preserve exact schemas, result details, renderers, and prompt metadata.
4. Route user `!` and `!!` through `user_bash`; an enabled-but-unavailable sandbox must block, never return undefined and execute locally.
5. Add user commands:

   ```text
   /sandbox status
   /sandbox doctor
   /sandbox on
   /sandbox policy
   /sandbox off
   ```

6. Use ordinary `ctx.ui` approvals/status and session entries for non-secret binding metadata. `/sandbox on` explicitly selects Sandboxed mode for this session/thread; `/sandbox off` explicitly selects Bypass after the mode-transition checks. The model gets no tool that disables or widens enforcement.
7. Restore the saved mode on `session_start`: leave Bypass on its existing host path, and reconcile owned enforcement before admitting protected tools. Close session-owned resources idempotently on `session_shutdown`. Each protected tool checks readiness at execution time: a logged startup-hook failure must not leave host tools usable.
8. Reject unsupported/unapproved tools while the profile is active. Explicitly identify trusted host capabilities; tool annotations are hints, not verified containment.

Use `create*ToolDefinition`/operation interfaces rather than rewriting file/edit/output behavior. Existing Gondolin/SSH examples demonstrate routing but are not security-complete templates; do not copy host-environment forwarding or simplistic quoting.

### SRT integration details

The trusted supervisor uses the published APIs `checkDependenciesAsync`, `initialize`, `wrapWithSandboxArgv`, violation reporting, `cleanupAfterCommand`, and `reset`. `wrapWithSandboxArgv` returns `{ argv, env }`; we still own spawn, stream, timeout, process-tree termination, and cleanup.

Use explicit command attribution IDs. If later adding per-command network grants, use SRT's required unguessable IDs and do not mistake their attribution for isolation between concurrent commands.

### Compatibility details that cannot be skipped

- Native pi read-path resolution currently probes host paths for filename variants before delegated reads. Resolve mapped paths correctly and restrict claims to the actual containment boundary.
- Built-in bash spills output into host temp files. Provide access to **only the corresponding artifacts**, or map them into worker-owned storage; do not grant the entire host temp directory.
- Preserve binary/image handling, Unicode paths, exact edit semantics, output truncation, and cancellation.
- Preserve per-file mutation queues across sessions. Workers seeing the same files at the same paths need shared namespace/lock coordination; random worker IDs must not disable cross-agent serialization.
- Fork/tree navigation must not restore revoked grants. Session entries describe the binding, but protected host state owns current policy/revocation authority.
- Later tool registration/replacement must not silently swap a routed tool for a host implementation. Arbitrary trusted extension code itself remains outside this profile.

**Exit gate:** native pi file/shell/search operations and `!` route through SRT; startup/reload/failure never falls back to host execution. Qualify macOS/Linux containment and concurrent policy independence separately. Windows must pass its setup, supported-operation, cancellation, and truthful-capability tests; known residuals remain visible and block strict-guarantee requests rather than being waived as security-test passes.

## Phase 2 — pi-durable support using the same SRT core

A normal pi extension is not a durable extension. Add a separate adapter and optional durable extension glue; do not duplicate SRT runtime management.

The actual pi-durable 1.4 integration seam is `HarnessOptions.env`:

```ts
// Existing upstream type shape, simplified.
env?: (
  target: { conversationId: string; cwd?: string; read: DocumentReader },
  context: Context,
) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
```

### Deliverables

1. Select the environment from the persisted thread/agent protection binding. Bypass retains the existing `NodeExecutionEnv` behavior; Sandboxed uses `ExecutionEnv` over the same SRT worker/session, including **all required filesystem and shell contracts**, not just `exec`. The per-use environment factory reuses the owned binding/generation rather than starting a supervisor on every tool operation.
2. Preserve text/binary/open-reader semantics, line scans, writes/append/truncate/flush/rename, metadata/directory paging, path canonicalization, temporary resources, watchers, typed errors, and stable namespace IDs. Return supported contract errors where appropriate; never delegate missing operations to host FS.
3. Preserve string-shell vs argv execution, cwd/environment policy, timeout seconds, stream-aware UTF-8 decoding, output windows, spill-file access, and nonzero exit results.
4. A command abort cancels that command/process tree. Environment `cleanup` is owner-level teardown and must not terminate siblings when one tool is cancelled.
5. Add durable policy documents/authorization hooks and command correlation using `api.callId` or equivalent explicit context; the environment factory itself has no call ID.
6. Persist the selected protection mode, inherited capability ceiling, effective policy, resource/generation/namespace, and create/command cleanup intents **before** submission can schedule work.
7. Use environment-conformance helpers from `@earendil-works/pi-durable/testing`, plus SRT-specific concurrency and crash tests.

### Recovery contract

1. Acquire the existing durable ownership lock.
2. Load policy/bindings and reconcile supervisor/worker ownership, generation, and incomplete commands. PID existence alone is insufficient.
3. Reconnect valid owned resources or recreate only after the old work is confirmed stopped and recovery policy permits it. Invalidate stale file handles.
4. Keep uncertain mutations, policy changes/revocations, unavailable enforcement, and cleanup problems held for review. Preserve existing cleanup/crash-loop safeguards.
5. Only then permit `harness.resume()` or submissions that schedule work.

**General shell execution remains replay-unsafe.** A command can finish a side effect before its result is committed. SRT does not provide exactly-once execution or a durable command reattach contract. Losing a supervisor/client must not cause an automatic rerun of interrupted mutations.

No automatic harness-owned environment cleanup was found in the inspected path, so lifecycle ownership must be explicit. The durable database and model credentials stay on the trusted host side.

**Exit gate:** full environment conformance, stable cross-agent locks, sibling-safe cancellation, clean teardown, persisted policy/assurance, and recovery-before-resume on all supported platform/architecture combinations. Windows recovery revalidates machine-wide setup and prior experimental acceptance; a changed or missing setup holds the agent. Interrupted mutating commands stay uncertain/held rather than being replayed.

## Phase 3 — pi-kit integration and complete advertised capability coverage

Use the ordinary package and its shared core. Native pi remains independently functional.

| Repository seam | Planned work |
| --- | --- |
| `apps/backend/src/pi/session-lifecycle.ts` | Resolve the saved thread-protection mode; preserve the Bypass path and enforce readiness before admitting a Sandboxed run; supply the thread-owned package binding |
| `apps/backend/src/pi/coordination-extension.ts` | Compose reviewed shell metadata without replacing the sandbox's `bash` definition afterward |
| `apps/backend/src/pi/mcp-transport.ts` | Govern stdio server launch **and config `!command` helpers**; explicit policy for remote endpoints. Block unsupported paths until routed |
| `apps/backend/src/pi/session-mcp.ts` | Enforce capability policy on direct MCP App actions that bypass pi `tool_call` hooks |
| `apps/backend/src/bg-agents/bg-agents.service.ts` | Select sandbox `ExecutionEnv` from persisted bindings, reconcile before resume, own resource lifecycle |
| `apps/backend/src/bg-agents/agent-extension.ts` | Persist inherited policy ceiling/binding before submit; approvals cannot bypass it |
| `apps/backend/src/bg-agents/process-job.ts` | Extend cleanup intents with owned resource/generation/command identity and reconciliation result |
| Package host and shared protocol | Reuse package installation and UI bridge; validate any new status/config/approval messages without exposing SRT internals or secrets |
| Thread/composer protection selector, Settings, agents panel | Select Bypass or Sandboxed independently per thread; show effective coverage/policy, dependency checks, approvals, and recovery state; optional defaults seed only new threads |
| Browser/artifact/terminal/other host brokers | Explicit scoped permissions or unavailable in the profile; no generic host-execution escape hatch |

### Product semantics

- The authoritative unit is the thread: **Bypass is the shipped default on all platforms**, and Sandboxed is an explicit opt-in. Persist its mode and each run's effective generation; workspace/user defaults never replace existing thread decisions.
- Show **Bypass / Sandboxed** as the protection selector. For Sandboxed mode, separately display **Starting / Active / Experimental / Awaiting approval / Unavailable / Recovery required**, with the coverage label **“Sandboxed tools; host extensions trusted.”** An unavailable protected thread stays Sandboxed, never appears as Bypass. Windows uses **Experimental**, with network/read-isolation limitations visible rather than hidden in setup notes.
- A missing/removed package cannot silently disable an enabled policy. Backend admission remains authoritative.
- The extension bus is UX plumbing, not an authenticated grant boundary. Host policy validates configuration/approval changes.
- Background agents inherit the parent capability ceiling before starting. `read-only`, `edit`, and `isolated` remain workflow permissions; “Allow all” does not widen sandbox access.
- Derive child rules from a constrained parent capability set or reuse the exact policy; do not compare arbitrary policy text to guess which is stricter.
- Git worktrees may reference a common Git directory outside their folder. Explicitly qualify narrow access or broker necessary Git actions; do not expose home/parent directories just to make Git work.
- Developer previews need narrow, explicit port access, not a blanket localhost grant. Spill files/artifacts need scoped handles and a defined cleanup lifetime.

**Exit gate:** main and background agents honor the same policy and assurance requirements; MCP/helpers and host capabilities are routed or visibly blocked; stop/restart/reload/package removal cannot downgrade protection. Previews and artifact reads either work with reviewed access or report that the requested guarantee cannot be met. Windows setup, experimental consent, persistent-grant state, and recovery status are visible in both native pi and pi-kit.

## Validation and release gates

Run a shared operation/lifecycle suite on **macOS, Linux, Windows x64, and Windows arm64**, with platform-specific enforcement tests. Publish observed restrictions and residuals rather than asserting identical guarantees. Windows alpha acceptance requires supported-operation tests and accurate warnings/refusals; it does not convert known escape paths into passed containment tests:

- Private files, sensitive workspace files, symlinks/hardlinks/rename races, traversal, and writes outside approved paths.
- Direct Node/Python file/network operations, nested shells, shell startup hooks, and hostile environment variables.
- Egress ignoring proxy variables, DNS/IPv6/redirects, private/metadata/localhost destinations, and exfiltration to an otherwise allowed destination. Record residual channels/limitations; do not claim perfect data-loss prevention.
- Binary/images, Unicode/quote/newline filenames, large output and bounded transport, spill files, file watcher overflow, exact-edit conflicts, and shared-workspace concurrency.
- New and legacy threads default to Bypass on all platforms, with no SRT import/probe/process/proxy/setup side effects; existing host behavior works when the optional package is absent.
- Concurrent Bypass and Sandboxed threads in the same cwd; two protected threads with different policies during reset/reload/crash/stop; changing or closing one never alters the other. Exercise reuse of a cached extension factory, not only separate CLI processes.
- Per-thread mode persistence across reopen/resume/fork/tree navigation, explicit mode-switch consent, pending/uncertain transitions, and new-thread-only defaults; parent/child policy ceilings never widen automatically.
- Cancel one command without killing siblings; no surviving unowned descendants.
- Crash before worker creation returns, after command start, after side effects, and before durable commit; stale resource identity, revoked policy, restart, and uncertain mutations.
- Missing dependency/package, unsupported OS, unavailable worker, headless approvals, and invalid configuration: visible failure, no unrestricted fallback.
- MCP config helpers, direct app calls, late tool replacement, PTYs, browser/computer-use, plugin requests, and explicit unsupported-capability refusal.
- Windows: UAC denial/setup repair/version mismatch, persistent grants/profile warnings, shared-account cross-workspace reads, junctions/ACL aliases/UNC handling, machine-wide proxy/loopback conflicts, Schannel failures, helper/job-object teardown, and known egress residual detection. Do not claim cross-scope read isolation or hostile-code network containment on this backend.

Native Windows runners are required before shipping Windows support; source inspection or a Linux/WSL run is not a Windows test. No Windows workload has been executed during this planning task.

Measure cold start, per-file round-trip and large-read overhead, build/test performance, streaming delay, supervisor memory/process footprint, cancellation latency, and recovery time. Do not present unmeasured performance or crash-safety guarantees.

## Explicitly deferred

- Automatic WSL setup and any Windows production-security, multi-tenant isolation, or hostile-code network-containment claim. **Native Windows experimental support itself is included.**
- Other sandbox engines, provider registry, remote/cloud execution, Docker or GPU dependencies.
- NeMo/content guardrails; sandboxing is not semantic prompt-injection detection.
- Supervisor pooling, per-command policy widening, or generic shell replay/reattachment guarantees.
- Whole-agent isolation of arbitrary extension initialization. That requires a boundary before resource loading and a reviewed host broker, not additional extension hooks.

## References

- [Published SRT 0.0.81 metadata](https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/0.0.81), [npm package](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime/v/0.0.81), [upstream repository](https://github.com/anthropic-experimental/sandbox-runtime).
- Inspected SRT package: README, `dist/sandbox/sandbox-manager.{js,d.ts}`, configuration schemas, filesystem defaults, command attribution, cleanup, and Windows alpha limitations.
- Repository-installed pi 1.4.0: `docs/extensions.md`, `docs/containerization.md`, `examples/extensions/gondolin/index.ts`, `examples/extensions/ssh.ts`, and `dist/core/tools/*`.
- Repository-installed pi-durable 1.4.0: `README.md`, `dist/harness/types.d.ts`, `dist/env/index.d.ts`, `dist/harness/tool.js`, `dist/tools/bash.js`, and testing exports.
- pi-kit contracts: [plugins](../docs/plugins.md), [background agents](../docs/background-agents.md), `apps/backend/src/pi/session-lifecycle.ts`, `apps/backend/src/pi/coordination-extension.ts`, and `apps/backend/src/bg-agents/`.
