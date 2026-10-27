# ADR-0018: Connectors: one-click remote MCP servers through pi's own configuration

Status: Accepted
Date: 2026-10-16

## Context

pi connects to remote MCP servers natively: an HTTP entry with a `url` in `mcp.json`, `/mcp login <name>` for the
browser sign-in, tokens in `~/.pi/agent/mcp-auth.json` that pi refreshes, and an `exposure` per server. pi-kit already
has the MCP panel and MCP Apps. What a person still does by hand is find the vendor's endpoint, write the entry and
learn which command signs in. A connector is that, as one click.
Constraints that already hold: no secret in plain text in pi-kit's database or in a file a store could hold; a
project's `.pi/mcp.json` is read only for a trusted folder; the backend on loopback with a per-launch token; renderer
state in NgRx SignalStores; dependencies pinned and latest, so none are added.

## Decision

- The catalog is data, validated by a zod schema in `libs/protocol/src/connectors.ts` and built into the release. An entry
  has an `id` (the server's name in `mcp.json`), vendor, a monochrome logo as SVG path data only (never markup), an https
  endpoint with optional read-only variants, a sign-in mode (`oauth`, `cimd`, `oauth-client`, `bearer`), a suggested
  `exposure`, highlights and a verification mark. An endpoint not checked against the vendor's own documentation is
  `unverified` and the card says so; an endpoint is never guessed.
- The backend serves the catalog at `GET /api/connectors/catalog`. The schema carries an optional ed25519 `signature` so a
  signed catalog can replace the built-in one later; nothing fetches one yet.
- Connect writes pi's own configuration and lets pi do the rest: `POST /api/connectors/connect` builds the `mcpServers`
  entry in pi's format, writes it to the user's `mcp.json` (or the folder's `.pi/mcp.json` for "Project only"), reloads
  the thread's session and, for a sign-in connector, starts pi's own `/mcp login <name>`. The writer replaces only
  `mcpServers[name]`, writes atomically, and refuses a file that is not a JSON object.
- pi-kit keeps no connector database and no token of its own. Sign-in state (`waiting`, `failed`, `cancelled`) is read
  from pi's notifications; wording pi-kit does not recognise degrades to "did not happen", never to a false success.
  Cancel and Paste answer pi's own prompt. A token that stops working later shows as pi's `needs-auth`.
- OAuth tokens are pi's, in `mcp-auth.json`. Disconnect runs pi's `/mcp logout <name>`, then removes the
  entry; without a session it is refused rather than leaving a token behind.
- A bearer token or a registered client's secret goes into the credential store under `connector-<id>` or
  `connector-<id>-secret`; `mcp.json` holds a resolver command that prints the whole header or secret. Without a store
  the plain value is written to the user file and the answer says so. A connector with a secret is never written to a
  project file.
- "Project only" requires that the folder's trust was answered (`TrustService.folderTrusted`); otherwise the request is
  refused and the gallery offers "Trust this folder" first. Nothing is written before.
- Surfaces: Settings › Connectors and the `/connect` action; cards in `ConnectorsStore` with six states, one primary
  action and an exposure menu (Direct, Codemode, Deferred) saved to the file that defines the server; servers that match
  no card are listed under "Your own servers"; a connected `direct` server is a "Connectors" group in the `/` menu.

## Consequences

- One click from nothing to a signed-in server, and the pi command line sees exactly the same servers and tokens.
- A connector is pi configuration plus a card; there is nothing in pi-kit to migrate or back up.
- Remote servers run with the person's account and can write; the exposure menu and read-only variants are pi-kit's
  controls, pi's permission extensions still apply to every call.
- The catalog is only as correct as the vendors' documentation; each entry says what was read, and an unreadable one is
  marked rather than filled in. Figma accepts only clients in its catalog, under a client name it may stop accepting.
- The attendant agent does not yet suggest a connector when a prompt names a vendor.
