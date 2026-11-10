# Research: opt-in agent sandboxing and security

Research date: 2026-11-06. Status: original market research, not an implemented security guarantee.

**Current decision:** implement an opt-in **SRT-only pi extension**, shared with pi-kit and pi-durable. Protection is **independent per thread**: **Bypass is the default on macOS, Linux, and Windows**, preserving current host execution; the user may explicitly select Sandboxed mode for an individual thread. Native Windows protection is explicitly experimental, with its known isolation limitations disclosed. OpenShell, NeMo, cloud runtimes, and other engines below are background research, **not implementation work**. The [SRT-only implementation plan](sandbox-extension-design.md) supersedes the original shortlist and evaluation phases on this page.

## Original executive recommendation (historical)

Offer **execution isolation** and **AI guardrails** as separate, independently opt-in capabilities. They address different threats and can be combined.

- **Execution sandbox:** limits what agent-controlled code can read, write, execute, and contact, even if the model follows a malicious instruction.
- **Guardrails:** inspect prompts, retrieved content, tool arguments/results, and responses for sensitive data, prompt injection, or customer-specific policy violations. They are fallible checks, not an OS security boundary.
- **Tool authorization:** deterministic rules and explicit approval for sensitive operations. Required alongside either option.

**Recommended shortlist:**

1. Evaluate **Anthropic Sandbox Runtime (`srt`)** for a lightweight local macOS/Linux integration. It has a TypeScript library and can wrap arbitrary processes and local MCP servers. Do not equate a shell-only integration with whole-agent isolation.
2. Evaluate **NVIDIA OpenShell** in parallel for customers wanting a policy-governed agent runtime, credential mediation, and enterprise deployment. It is the NVIDIA product more directly aligned with execution isolation.
3. Offer **NVIDIA NeMo Guardrails** as an optional policy service for customers who need semantic/content controls. It complements either sandbox; it does not replace one.
4. For deliberately hostile code or remote multi-tenant execution, evaluate a **gVisor or microVM-backed worker**, optionally via a managed service such as **E2B**. This is a separate deployment tier, not a dependency every desktop user should install.

Do not add mandatory NVIDIA infrastructure, Python, Docker, a GPU, or a cloud account to the default desktop experience. Installation, telemetry, and remote data transfer need their own disclosures and consent.

## Current pi-kit position

The repository already has useful security controls, but they protect different boundaries:

| Existing control | What it protects | What it does not establish |
| --- | --- | --- |
| Loopback backend, per-launch bearer token, origin restrictions | Access to the powerful local API | Containment of commands legitimately requested by an agent |
| Electron renderer isolation and browser/MCP/generated-UI sandboxes | Untrusted web content vs. desktop privileges | Isolation of backend tool execution |
| Project trust before project resources load | Whether project extensions, skills, and MCP configuration may load | A trusted extension being unable to access the host |
| Background-agent permissions and worktrees | Workflow authorization and separation of changes | An OS boundary; a worktree is not a sandbox |

The SDK currently runs **in the backend process**. Host-executed extensions or tools therefore need special treatment: wrapping `bash` alone cannot contain Node filesystem calls, extension initialization, or an independently launched MCP process.

Repository evidence: `doc/docs/architecture.md`, `doc/docs/adr/0001-pi-as-the-agent.md`, `doc/docs/adr/0007-local-security.md`, `doc/docs/adr/0013-packaging-crash-recovery-and-updates.md`, `doc/docs/adr/0028-learning-from-finished-threads.md`, `doc/docs/background-agents.md`, and `apps/backend/src/pi/trust.service.ts`. Consult implementation as the current authority; older ADRs describe decisions at their original date.

## Options compared

Effort below is a relative engineering assessment, not a benchmark or delivery estimate.

| Option | Primary role | Deployment / fit | Main limitations | Relative effort |
| --- | --- | --- | --- | --- |
| **NVIDIA NeMo Guardrails** | Programmable input, dialog, retrieval, execution, and output checks | Python library or HTTP service; backend can call a customer-managed endpoint | No process isolation; latency, false positives/negatives, and model/service costs depend on chosen rails | Medium for narrow checks; higher for full provider/streaming integration |
| **NVIDIA OpenShell** | Policy-governed agent execution; filesystem/network/process controls and credential mediation | Local or hosted gateway and sandbox workers; upstream lists Linux, Apple Silicon macOS, and experimental WSL2 support, subject to prerequisites | Additional runtime/control plane; support varies by backend/platform; integration and exact guarantees require a pinned-version evaluation | Medium–high |
| **Anthropic `srt`** | OS-enforced process filesystem and network restrictions | Node/TypeScript integration; macOS Seatbelt, Linux bubblewrap; upstream also documents Windows alpha | Does not automatically cover tools running outside wrapped processes; default reads are broad; Windows has documented egress gaps | Medium for process tools; high for complete agent coverage |
| **Hardened Docker/Podman container** | Isolated environment and reproducible toolchain | Local Linux or a desktop VM, or remote worker | Shared Linux kernel; unsafe mounts, privileged mode, or runtime socket exposure undermine isolation; network policy is additional work | Medium–high |
| **gVisor (`runsc`)** | Additional userspace application-kernel boundary for containers | Linux execution workers, integrates with OCI tooling | Linux syscall/workload compatibility and performance must be tested; not a native macOS runtime | High |
| **Firecracker / microVM worker** | Hardware-virtualized guest boundary | Linux/KVM infrastructure, especially hostile multi-tenant workloads | Images, orchestration, networking, storage, patching, and observability are our responsibility if self-operated | High |
| **E2B** | Managed remote execution sandboxes with JS/Python SDKs | Optional cloud worker | Source/data leave the machine; commercial terms, residency, retention, network controls, and limits need review | Medium integration; external operational dependency |
| **OPA / deterministic local policy** | Allow/deny decisions over structured requests | Local rule engine or policy service | A decision engine is not an enforcement boundary; every relevant path must invoke it | Low–medium for a small local policy layer |
| **Microsoft Presidio / Guardrails AI** | PII de-identification / output and schema validation | Optional service or validation integration | Different scope from runtime isolation; detection can miss sensitive material; validator/model licenses may differ | Medium |

A simple rule-based layer may be sufficient when the customer only needs “no access outside this project” or “ask before pushing.” NeMo is more useful when the requirements include semantic decisions, data classification, or governed conversational behavior.

### NVIDIA NeMo Guardrails: what it would add

Upstream supports checks around user input, retrieved material, custom tool actions, and generated output. Useful candidate policies include:

- Detect or redact selected PII before an external model receives it.
- Inspect untrusted repository, web, and MCP content for injection attempts.
- Apply customer-specific content and response policies.
- Check structured tool arguments before deterministic authorization and execution.

Integration should retain pi as the agent runtime rather than replacing the agent loop. Prefer a narrow adapter to a configured guardrails service, starting with input and untrusted tool-result checks. A full LLM proxy must prove compatibility with tool calls, provider-specific schemas, streaming, retries, cancellation, and resumed sessions.

**Important qualifications:**

- The library does not inherently require an NVIDIA GPU; specific local models or NIM deployments have their own compute and licensing requirements.
- “Execution rails” means checks around application actions, **not** kernel-enforced execution isolation.
- Output checks cannot undo a destructive tool call that already happened. Checks and authorization must happen before side effects.
- For strict output filtering, hold content until it passes. Streaming text directly to the user first makes subsequent rejection too late; chunked checks have different latency and detection trade-offs.
- Input-only filtering misses indirect prompt injection in tool results, repository files, retrieved documents, and web pages.
- Guardrail configuration can include Python actions. Treat configuration/code as privileged administrator-controlled material, not something a repository or agent can silently replace.
- Guardrails can also see secrets. Sending content to an external checker is a separate disclosure from sending it to the selected model.

### NVIDIA OpenShell: why it belongs on the shortlist

OpenShell's upstream documentation describes runtime policy enforcement for file access, system calls, and outbound connections, plus credentials added to approved requests without exposing the real credentials to the agent. It also describes policy-change verification and human review, a gateway architecture, and SDKs including TypeScript.

This aligns more directly with the customer's sandboxing question than NeMo alone. However, these are upstream capabilities, not verified pi-kit guarantees. A proof of concept must establish the selected compute backend, workspace mounting, provider authentication, dev-server access, MCP lifecycle, cancellation, resource limits, and platform support. Do not assume every backend has identical enforcement or that advertised policy verification proves the absence of runtime vulnerabilities.

OpenShell currently documents operational telemetry and a disable setting. A pi-kit integration should make that visible and choose privacy-preserving defaults rather than treating local execution as automatically telemetry-free.

### Anthropic `srt`: promising lightweight path, with caveats

Upstream offers a library, not only a CLI, and describes wrapping agents, shell commands, local MCP servers, and arbitrary processes.

- Filesystem writes are allowlisted, but **reads are broadly allowed by default**. Explicitly deny home/private data and permit only necessary project/toolchain paths; reject a configuration that cannot meet the advertised isolation profile.
- Network access is mediated through proxies plus OS restrictions. Setting proxy environment variables alone is not isolation.
- macOS and Linux use different primitives; test both. macOS relies on `sandbox-exec`/Seatbelt and its long-term platform viability needs review.
- Upstream labels native Windows support **alpha** and documents direct egress bypasses involving impersonated/derived tokens and service-mediated traffic. Do **not** present that backend as hostile-code network containment. Evaluate a VM-backed route instead, with its own threat model.
- A wrapped shell still does not contain built-in file tools or arbitrary extensions running in the backend. A stronger profile needs a dedicated sandboxed agent/tool worker and a narrow host broker.

## Proposed opt-in product model

Keep the settings orthogonal; never label content filtering as “sandbox enabled.” The current execution-isolation scope is the SRT-only plan; guardrails remain separate background research, not implementation work. Suggested concepts, not an existing API:

| Setting | Default | Enabled behavior |
| --- | --- | --- |
| Thread protection | **Bypass** / current execution model, on every platform | Explicitly select Sandboxed mode for this thread, with a thread-owned local SRT runtime and resource policy |
| Guardrails | Off / out of scope for this implementation | A separately evaluated policy service, not implied by enabling SRT |
| Approvals | Existing behavior | Protected policies for external writes, destructive actions, and network grants; approvals cannot silently bypass an enabled thread's sandbox |

A readable profile could say: **“Local sandbox: project read/write, private files blocked, network denied except approved destinations; guardrails off.”** A shell-only first release must instead say **“Shell sandbox only: other tools and trusted extensions retain host access.”**

Requirements:

1. Opt in **per thread**, with Bypass as the shipped default on every platform. Optional user/workspace preferences seed only new threads; existing threads retain their saved mode. Resolve to an immutable effective policy for each run; show the selected mode separately from actual readiness. Threads sharing a workspace must not share mutable runtime ownership.
2. Persist the effective policy identity/version with the durable run. Resume, replay, headless execution, and background agents must preserve restrictions or stop for review. Child agents cannot expand parent permissions.
3. Once opted in, **fail closed** if the sandbox/checker is unavailable, misconfigured, or times out in enforcement mode. Do not silently retry on the host or bypass the checker. Audit mode must be visibly different.
4. Changing to a weaker policy requires explicit user/admin action, not a model tool call or project configuration. Existing children must stop or be restarted under a clearly displayed policy.
5. Keep real credentials and the backend bearer token outside the execution worker. Use narrowly scoped brokered operations or destination-bound credentials; do not forward the host environment wholesale.
6. Deny private filesystem locations, host control sockets, privileged mode, arbitrary IPC, and unneeded inherited descriptors. Limit CPU, memory, disk, output, time, and process count where the backend supports them.
7. Default network deny, then explicit grants. Protect localhost services, private/link-local ranges, cloud metadata endpoints, redirects, DNS rebinding, and alternate protocols. A domain allowlist alone does not prevent data exfiltration to an approved service.
8. Keep policy and guardrail control endpoints inaccessible to sandboxed code. Workspace edits must not be able to expand the policy.
9. Audit decisions with run/tool ID, policy version, backend, result, and reason. Avoid recording full prompts, tool output, or credentials by default; document retention/export.
10. Remote workers and external classifiers require separate data-transfer consent, residency/retention review, and clear cost information. Turning on a local sandbox must not silently enable cloud execution.

Opt-in is a usability/deployment choice, not a claim that existing backend authentication or renderer isolation can be disabled. Enterprise administrators may optionally mandate a profile; enforcement cannot live only in the UI.

## Integration shape and coverage

```text
User / untrusted tool result
  -> optional guardrail checks
  -> pi agent proposes action
  -> deterministic tool authorization + approval when required
  -> sandboxed worker or explicitly trusted host broker
  -> result checks/redaction before model context and user display
  -> content-free decision audit
```

Keep Electron, the HTTP API, durable orchestration, credential storage, and policy enforcement outside untrusted execution. Move agent-controlled tools and untrusted extension code into a worker when claiming whole-agent isolation. The existing RPC/subprocess direction is a candidate transport, not isolation by itself.

Coverage must include filesystem tools, shell/subprocesses and descendants, extension initialization and direct execution, local MCP servers, remote MCP calls, background agents, headless/replay jobs, and host capabilities such as browser/computer-use tools. Browser-mediated network access and user-clicked MCP actions can bypass a shell-only policy unless explicitly governed. Host brokers must expose narrow reviewed operations, not unrestricted command execution behind an RPC name.

### Concrete implementation seams found in the repository

| Path | Integration implication |
| --- | --- |
| `apps/backend/src/pi/session-lifecycle.ts` | Admit the effective policy before `DefaultResourceLoader.reload` and `createAgentSession`; loading extension code already executes host code. |
| `apps/backend/src/pi/coordination-extension.ts` | Existing `createBashToolDefinition` / `spawnHook` is a candidate shell-wrapping seam. SDK filesystem tool operation overrides need equivalent coverage; shell wrapping alone is insufficient. |
| `apps/backend/src/pi/trust.service.ts` | Trust probing itself loads user extensions. A hostile-extension boundary must exist before this, not just before the first tool call. |
| `apps/backend/src/bg-agents/bg-agents.service.ts` | Background agents use a separate durable harness and `NodeExecutionEnv`; confine its execution **and filesystem** operations and propagate policy explicitly. |
| `apps/backend/src/bg-agents/agent-extension.ts` | Current read-only mode uses tool checks and a shell-command regex. It is not adversarial containment: allowed commands can invoke scripts or other executables. Do not reuse the label as proof of OS-enforced read-only access. |
| `apps/backend/src/pi/mcp-transport.ts` | Govern both stdio launch and HTTP destinations. Configuration `!command` values run via host `execSync` **before** transport creation, so wrapping only the MCP server misses a host execution path. |
| `apps/backend/src/pi/session-mcp.ts` | MCP App tool clicks deliberately call definitions directly without pi `tool_call` hooks. Shared authorization must cover this explicit user-action path too, with appropriately distinguished consent. |
| `apps/backend/src/pi/session-ui.ts` | Execution-event subscriptions observe activity; do not mistake them for blocking authorization. Use pre-execution hooks/brokers and test ordering. |
| `apps/backend/src/pi/process-runner.ts` | Useful subprocess seam, but not universal. SDK bash, durable execution, PTYs, Git helpers, MCP config commands, installers, and host automation require a separate coverage inventory. |
| `apps/backend/src/pi/load-pi.ts` | The SDK can be dynamically selected; pin or compatibility-check the APIs and versions relied on for enforcement. |

These are candidate seams from source inspection, not completed integrations. A non-bypassable design requires the boundary to be outside untrusted extension code; an extension hook alone is not sufficient against another arbitrary host-privileged extension.

## Original evaluation plan (superseded)

### Phase 1 — agree the threat model

Ask whether the customer prioritizes accidental damage, indirect prompt injection, secret/PII leakage, malicious extensions, hostile generated code, or remote multi-tenancy. Confirm supported OSes, offline requirements, administrator privileges, approved services, and whether repository contents may leave the machine.

### Phase 2 — compare two isolation proofs of concept

Compare `srt` on supported macOS/Linux with OpenShell using the **same workloads and policy**. No production security claim until a pinned release passes the coverage checks. Treat the shell-only prototype as limited scope. Add gVisor/microVM evaluation if malicious code or multi-tenancy is in scope.

### Phase 3 — add guardrails only where needed

Integrate a customer-controlled NeMo endpoint in **audit mode** first using non-sensitive evaluation data. Measure false positives, missed attacks, latency, and operational cost before enforcing policy. No checker outage should silently become permission to continue in enforcement mode.

### Acceptance tests

- Read/write outside the allowed project; home credentials and `.env` files; symlinks, path traversal, hardlinks, and rename races.
- Direct Node/Python access, extension startup, nested shells, subprocess escape attempts, and processes surviving cancellation.
- Egress through ignored proxy variables, DNS, IPv6, redirects, localhost/private networks, metadata endpoints, and allowed-domain exfiltration.
- Docker/Podman sockets, SSH agents, inherited descriptors, MCP servers, browser/desktop brokers, and user-triggered MCP actions.
- Policy widening via repository edits, background-agent spawning, resume/replay, backend restart, and headless jobs.
- Checker timeout, invalid policy, missing sandbox dependency, and unsupported OS: fail visibly without host fallback.
- Prompt injection in repository/web/MCP results, PII leakage before provider transmission, and streamed output leakage before approval.
- Normal development: install dependencies, build/test, Git/worktree operations, preview servers, file watching, cancellation, and offline use.

Record coverage and restrictions by OS/backend. Measure cold start, execution overhead, P50/P95 added checking latency, false-positive rate on legitimate coding tasks, resource use, and remote cost. No comparable benchmark was executed for this research.

## Primary sources and confidence

Reviewed upstream project documentation/READMEs on the research date. Several sources are moving `main`/`develop` branches; features there may not be in a released package. Pin release artifacts and re-check platform support, security advisories, licenses, model terms, and managed-service contracts before adoption. This is a documentation-based comparison, not a penetration test or certification.

- [NVIDIA NeMo Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) — scope, rail types, Python/service integration, and model-dependent checks; [documentation](https://docs.nvidia.com/nemo/guardrails).
- [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) — runtime policy, credentials, SDKs, and telemetry; [support matrix](https://docs.nvidia.com/openshell/latest/about/support-matrix), [architecture](https://docs.nvidia.com/openshell/latest/about/architecture).
- [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) — platform implementations, filesystem defaults, library integration, Windows alpha limitations. Review the Windows “Known limitations” section before making any egress-isolation claim.
- [bubblewrap](https://github.com/containers/bubblewrap) — Linux isolation building blocks; safety depends on the caller's policy.
- [gVisor](https://github.com/google/gvisor) — userspace application kernel and OCI runtime.
- [Firecracker](https://github.com/firecracker-microvm/firecracker) — Linux/KVM microVMs and production-host responsibilities.
- [E2B](https://github.com/e2b-dev/E2B), [E2B documentation](https://e2b.dev/docs) — cloud sandbox and SDK integration; contractual/residency properties remain procurement questions.
- [Open Policy Agent](https://github.com/open-policy-agent/opa) — deterministic policy decisions, separate from enforcement.
- [Microsoft Presidio](https://github.com/microsoft/presidio) — PII detection/redaction and its explicit completeness caveat.
- [Guardrails AI](https://github.com/guardrails-ai/guardrails) — validation alternative, not process containment.

## Suggested customer response

> We plan to offer optional local tool sandboxing using Anthropic Sandbox Runtime (SRT), first as a reusable pi extension and then with shared pi-kit and pi-durable integration. Each thread has its own protection mode: Bypass is the default on macOS, Linux, and Windows and preserves current behavior; the user may explicitly enable Sandboxed mode for that thread without changing other threads. Windows protection uses an explicitly experimental alpha backend with known network and cross-scope read-isolation limitations, not equivalent containment guarantees. Restrictions and coverage will be visible, and an enabled sandbox will never silently fall back to Bypass or unrestricted host execution. This is execution sandboxing, not an AI content-filtering service, and it does not contain arbitrary extension code still loaded on the host. Implementation and platform qualification are still required.
