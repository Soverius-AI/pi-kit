# ADR-0034: Backend folders are one module per domain with four roles

Status: Accepted
Date: 2026-10-22

## Context

`apps/backend` grew folder by folder, from one NestJS app through durable threads, the zod contract and background agents, without a record that says how it is cut. Before the code goes public the question is whether a reviewer reads its shape as a choice or as an accident, whether it is "DDD", and whether it is split the way NestJS projects should be.
NestJS prescribes nothing beyond modules, each "encapsulating a closely related set of capabilities" ([Modules](https://docs.nestjs.com/modules)); current guidance recommends feature folders and treats top-level `controllers/`, `services/` and `dtos/` folders, `forwardRef` cycles, logic in controllers and a `@Global()` on everything as anti-patterns. A layered or hexagonal split per feature is a community pattern for business rules that must outlive the framework; NestJS 12 adds Standard Schema validation, which this backend already uses instead of DTO classes.
This backend is an adapter around pi's SDK, SQLite, git, the file system and the keychain, with the renderer as its one client. Its weight is orchestration (runners, thread list, session service); its pure decisions (thread state, outcome rules, agent questions, verification verdicts) are small functions beside their one caller. A `domain/` layer per folder would move files without adding a boundary that anything crosses.

## Decision

1. **One folder per domain, and the folder is the module.** `src/<domain>/` holds everything of one concern and `<domain>.module.ts` wires it. A new domain is one folder plus one line in `app.module.ts`. There are no top-level `controllers/`, `services/` or `dto/` folders.
2. **Four roles inside a folder, named by file suffix.** `*.controller.ts` parses and delegates and holds no logic; `*.service.ts` is the behaviour (orchestration, pi, git, the file system, subscriptions); plain-named files are the pure functions, tested without I/O; `*.repository.ts` is one table or two and lives in `db/`, because all repositories share one connection and one migration list. A domain whose rules one day need a model of their own gets a `domain/` subfolder inside its slice, not a repository-wide layer.
3. **A shared kernel that imports no domain.** `pi/` (the one door to pi's SDK), `db/`, `secrets/`, `app/`, `contract/` and `desktop/`, plus `@pi-kit/protocol` for every schema the renderer shares.
4. **Domains reach each other through module exports only.** A module exports the services another module injects and nothing else; a cross-folder import of a file that is not a service, a module or a pure helper is a review finding. No new `@Global()` module. No `forwardRef`: a cycle is fixed in the structure.
5. **The contract is the edge, declared once.** Every route names its protocol schemas in Nest 12's `@Body({ schema })` and `@Query({ schema })` and in `@Responds`, `@Fails` and `@Streams`; the global guard, pipe and serializer do the rest. No DTO classes, no `class-validator`.
6. **Two deviations are tolerated, named, and not to grow.** A controller may inject a repository for a read that no service wraps; a service may throw an `HttpException` with a sentence for the person, because the renderer shows that sentence as it is and a second error vocabulary would only be translated back. A domain error that is also returned to pi's tools, as `browser` has, gets a filter at the controller boundary instead.

The [Backend](../backend.md) page draws the code as vertical slices, the view that matches the folder tree. Read as layers (HTTP, application, domain, infrastructure) the same files sort cleanly too; neither view asks for a file to move.

## Consequences

- A contributor who knows one folder knows them all; the [Backend](../backend.md) page lists the steps for a new route, domain, table, stream, session hook, session extension, plugin channel and background job, each pointing at the file to copy.
- The lint rules that enforce part of this stay: the four `@darraghor/eslint-plugin-nestjs-typed` rules, `no-floating-promises` outside specs, and the `no-restricted-imports` fence that keeps pi-durable inside a few named files of `bg-agents/`. The import rule of point 4 is a review rule until a violation appears.
- The two deviations are a known count. A change that adds to either is not refused; a change that wraps one of the direct repository reads in its service is welcome, since the cleaner cut for a public reader is a service per controller and nothing else injected.
- This is the answer to "is it DDD": no, by choice. The code has bounded contexts (the folders), a shared kernel and an anti-corruption layer around pi (`pi-session.service.ts`); it has no aggregates, no repositories as abstractions over a domain model and no layer that forbids the framework, because nothing here would be protected by them.
- Revisit when a domain accumulates rules tested through the service rather than through its pure functions, or when a second client of the backend appears.
