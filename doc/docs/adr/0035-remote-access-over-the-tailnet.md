# ADR-0035: Remote access over the user's tailnet, with paired devices and reciprocal instances

Status: Accepted
Date: 2026-11-04

## Context

Users want to continue a thread from a phone and to work on a project that lives on another computer of theirs. pi-kit's backend binds to loopback with a per-launch token and owns agent file and shell operations; exposing it to a network must not weaken that. A hosted relay would put the user's agent traffic, files and credentials on infrastructure pi-kit would have to run and trust, and would need accounts. Most users who want this already have a private network for their own devices: Tailscale gives every device a stable name, mutual authentication and, with Serve, a trusted HTTPS certificate for a service on one machine without opening a port on the router.

## Decision

- Remote access is publication on the user's own tailnet, through foreground `tailscale serve`, turned on explicitly in Settings with a chosen port and never at startup for a profile that did not have it on. pi-kit never runs `up`, `down`, `funnel` or `reset`; it discovers the installed CLI, calls it with argument arrays and reads status before and after publishing.
- The backend stays loopback-only and unchanged. A remote gateway in `libs/shared/service-host`, listening on a random loopback port, holds the backend token on behalf of remote clients. It authenticates callers itself and forwards only the routes a controller marks `@Remote()`, read from the OpenAPI document into a generated allowlist; administrative routes, HTML documents, the embedded browser and sandboxes never cross.
- A device is a browser the owner approved through the desktop or CLI: a one-time pairing code, a six-digit confirmation shown on both screens, then an `HttpOnly` session cookie plus a CSRF nonce. Approvals persist in the profile's database until revoked; codes, pending requests and sessions expire. The phone receives the packaged renderer with a marker that switches its transport to cookie and nonce; it never learns the backend token.
- An instance is an environment: a stable UUID and an editable name. A project belongs to one environment and a thread keeps its project's environment. Two instances pair reciprocally with one invitation and one confirmation code approved by both owners; each stores a directional grant and signs every later exchange with an Ed25519 key AES-256-GCM sealed by the service host with an OS-store wrapping key or an explicitly enabled owner-only key file, checking the peer's pinned identity each time. A device approved at one instance may use that instance's directly paired peers through it, one hop, only where the owner allowed relaying.
- The public onboarding site is static and only explains the setup; it carries no application traffic and holds nothing.

## Consequences

- No hosted pi-kit relay or accounts; remote application traffic travels over the user's tailnet. Users without Tailscale have no remote access; the setup card and the onboarding site exist to get them there.
- The computer has to be awake with the service host and backend running; an attached desktop is not required for remote chat.
- Every remotely callable route is a deliberate decision in a controller and shows up in the contract; a new route is not remotely callable until marked.
- Trust is per device and per pair, not per person: an approved phone has the owner's rights on the reviewed routes, so remote access is never a way to share an agent with someone else.
- Pairing requires explicit owner approval at both instances and an identity key that can be unsealed. A missing or unreadable wrapping key is an error, never a silently regenerated identity. Legacy Electron `safeStorage` keys migrate through an attached desktop; headless hosts use the host sealing path.
