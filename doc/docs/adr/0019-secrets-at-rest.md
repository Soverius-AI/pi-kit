# ADR-0019: Secrets at rest: credential store, encrypted database, redaction

Status: Accepted
Date: 2026-10-16

## Context

Three kinds of sensitive data exist on disk: provider credentials in pi's `~/.pi/agent/auth.json` and MCP OAuth tokens in
`mcp-auth.json`, both written by pi (a provider `key` may be `!command`, which pi runs when the key is needed); pi-kit's
own data in the user-data folder (the SQLite replay log with full transcripts and tool output, change baselines, terminal
replay, logs); and pi's session files. Transcripts and tool output can contain secrets the person pasted or a command
printed. The backend is on loopback with a per-launch token; this ADR is about what is on disk. Reading an
operating-system credential store can prompt for consent (Touch ID, a password), so every read has to be deliberate, and
the pi CLI has to keep working without pi-kit running.

## Decision

- Credential storage is a choice: `credentialStoreEnabled` in `<data dir>/security.json` (0600, no secrets), set in
  Settings with a confirmation naming the possible prompts. A fresh macOS profile defaults to direct credentials and
  plaintext SQLite without touching the Keychain; Windows and Linux keep their store by default.
- With the store on, an API key goes into the credential store under service `pi-kit`, account `<provider>`, and
  `auth.json` gets `{ "type": "api_key", "key": "!<resolver>" }`; the plaintext key is never written there. The resolver
  is `pi-kit-secret get <provider>` (a CLI shipped with the app, on the backend's PATH and installable to the user's PATH
  on a click) or `secret-tool` on Linux, so the pi CLI keeps working without pi-kit.
- Stores: `MacKeychainSecretStore` on macOS (`keychain-store`, user-presence access control, the signed app's access
  group; an ad-hoc build reports the signing requirement instead of weakening storage), `@napi-rs/keyring` elsewhere
  and as `legacy`; `PI_KIT_SECRET_STORE` selects `macos`, `legacy`, `memory`, `file:<path>` or `none`.
- With the store off or absent, `keep()` hands the literal key to pi and the UI says so; a cancelled or denied native
  operation never falls back to plaintext. Existing keys and configs migrate only on an explicit action, never at startup.
- OAuth tokens stay where pi puts them, refreshed by pi. Connector secrets follow the key rules under `connector-<id>`.
- Reads are deliberate: `available()` loads the native module without touching credentials, status reports capability
  separately (`unknown`, `ready`, `locked`, `denied`, `unavailable`, `failed`), a failed operation is kept until an
  explicit retry, secrets are never cached, operations are serialized, and Settings never reads a stored secret.
- The database is encrypted when the store is on: `better-sqlite3-multiple-ciphers` (ChaCha20-Poly1305), a random
  256-bit key stored as `pi-kit/db`; a plaintext file is encrypted by copy, rekey, verify and swap. An unreadable store
  is never reset and never gets a replacement key; `PI_KIT_DB_KEY` and "Export recovery key" (shown once) are the way
  back. Opting out never decrypts existing data. Terminal replay and change baselines live in the database too.
- Redaction is a pure function (`libs/protocol/src/redact.ts`, `[redacted <kind> …a1b2]`) applied to every AG-UI event
  before it is written, to previews and titles, the saved terminal screen, the transcript as drawn, and exports; not to
  pi's session file, the live terminal or `change_baselines`. A per-project switch and user patterns exist in Settings.
  It is independent of the credential store. A plaintext key is handled only inside the key workflow, never logged or
  returned to the renderer; transport stays loopback with the per-launch token.

## Consequences

- `pi` in a terminal resolves a stored key through the same command the file holds, with the app's signed helper on
  macOS and `pi-kit-secret` on PATH elsewhere; a real read may prompt for Touch ID or a password.
- Protection is a visible choice, not an automatic fallback; a fresh macOS profile is plain text until the person opts in.
- A lost store entry means an unreadable database; the recovery key and pi's session files are the way
  back, never a silent reset.
- Encrypted writes cost: the background compaction after a run is several times slower; opening a thread is unchanged.
- Redaction can hide text that only looks like a key; the transcript marks redactions and the pass can be turned off.
- Three native modules must load under Node and Electron's Node, and macOS needs a signed build.
