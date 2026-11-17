# ADR-0037: Promise-only SQLite off the JavaScript event loop

Status: Accepted
Date: 2026-11-17

## Context

The backend serves health checks, SSE, tools and inference in one Node process. A Promise-returning repository does not prevent a synchronous SQLite driver from blocking that process: preparing, stepping, checkpointing and committing still run on the JavaScript thread. Inference can produce enough replay and metadata writes to make unrelated requests wait. Moving only HTTP handlers or wrapping synchronous calls in `async` does not solve this.

The previous database driver also supported encrypted profiles. Changing that boundary must not mistake an encrypted file or an unavailable key for corruption, silently replace a profile, or claim equivalent at-rest protection from a driver that cannot open those files.

## Decision

- Use AppThreat's `@appthreat/sqlite3` asynchronous native driver through the backend's `AsyncSqlite` façade. Runtime repositories await `prepare(sql).get/all/run`, `exec`, `pragma` and `close`. There is no synchronous-driver fallback or blocking wait bridge.
- One queue owns each connection. An awaited transaction callback retains exclusive ownership through commit or rollback; nested transactions use savepoints. Read/check/write guards and write/read return snapshots belong inside the same transaction. Sequential insert/delete loops await each operation, rather than launching unobserved asynchronous `forEach` callbacks.
- `DatabaseService.create()` and the Nest provider factory await opening, migrations and instance identity hydration before consumers are constructed. The immutable local `instanceId` remains a synchronous cached property; repository constructors do not query SQLite. Shutdown drains accepted work and awaits close after domain cleanup.
- Native statement caching stays disabled. Even with drained `get()`/`all()`, a cached row-producing `run(... RETURNING)` can leave a native VM active and make commit fail. Measured hot-query speedups do not justify weakening cursor/transaction correctness.
- Bulk event deletion uses bounded, parameterized sets inside one transaction rather than one async native dispatch per sequence. Chunking retains thread scoping and all-or-nothing rollback.
- WAL and existing SQL migrations remain the storage contract. Replay event IDs are allocated by SQLite and can have gaps. Security-sensitive repository writes fence `synchronous = FULL` around the complete transaction and restore the previous setting afterwards; unrelated statements cannot enter that scope.
- Fresh app and background-agent databases are private **plaintext** files. Provider credential storage and sealed instance signing keys are separate capabilities; enabling a credential store does not enable database encryption in this backend.
- Before opening either profile database, reject an encrypted or unrecognized existing header and pending encryption-transition artifacts. Retain the originals and report an actionable error. Do not invoke corruption recovery, decrypt in place, generate replacement keys or automatically downgrade an encrypted profile to plaintext.
- An encrypted profile requires an explicit offline export using the previous encryption-capable build and the original key, followed by validation and a separately chosen plaintext migration. This ADR does **not** introduce a turnkey conversion command or an in-app migration workflow. Back up the original profile before any such operation; the async backend cannot recover or export encrypted contents itself.

## Consequences

- Database work no longer blocks the JavaScript event loop merely because SQLite is stepping a statement. Large result mapping, JSON serialization and filesystem work can still require their own bounds.
- Repository methods and their callers are asynchronous, including tests and shutdown hooks. Tests use `await DatabaseService.create(...)`, await every operation and close before removing temporary folders.
- Concurrency is now observable between awaited operations. Atomic guards, stable returned snapshots, per-thread event ordering and durable-before-publish boundaries need regression tests, not just type-checking.
- Existing plaintext profiles retain their metadata and migrations. Encrypted profiles fail closed until the owner deliberately performs a compatible offline conversion; this is a compatibility and security limitation, not transparent encryption support.
- This decision supersedes the runtime-driver and database-encryption portions of [ADR-0003](0003-pi-sessions-are-the-source-of-truth.md), [ADR-0010](0010-durable-threads.md), [ADR-0019](0019-secrets-at-rest.md), [ADR-0022](0022-latest-dependencies.md) and [ADR-0033](0033-durable-background-agents.md). Their source-of-truth, replay, credential and ownership decisions remain in force.
