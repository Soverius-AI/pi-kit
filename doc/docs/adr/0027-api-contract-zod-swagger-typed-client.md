# ADR-0027: One API contract: zod schemas, generated OpenAPI and SDK, overridable renderer policies

Status: Accepted
Date: 2026-10-17

## Context

The backend has about 140 hand-written REST routes in Nest controllers, plus the AG-UI run endpoint CopilotKit's runtime mounts and a few NDJSON
and SSE streams. Both sides share `libs/shared/protocol`, zod schemas and the types inferred from them, so payload shapes have one source of truth.
Routes do not: path, method, query and body-to-schema pairing live twice, the renderer casts every answer, and no OpenAPI document exists for
anything outside the two apps. Class DTOs with `@ApiProperty` would duplicate every schema; ts-rest replaces Nest's controller conventions;
`nestjs-zod` produces wrong OpenAPI under swagger 12. Nest 12 and `@nestjs/swagger` 12 understand Standard Schema, which zod 4 implements.
In the renderer, transport, authentication and error handling repeat per domain, behaviour (polling, retries, cache freshness, thresholds,
tooltip delays) lives in module-level constants no application can override, and the chat and settings stores are single large classes.

## Decision

- The protocol schema is the only definition. Every body, query and path parameter names its schema in the decorator (`@Body({ schema: CreateThreadSchema })`),
  every response in `@Responds(schema, { status?, array? })`; the parameter's type is `z.infer` of the same schema. There are no DTO classes and no `nestjs-zod`.
- A schema that other schemas nest, or that more than one operation uses, carries `.meta({ id })` in `libs/shared/protocol` and becomes one OpenAPI component;
  a query schema stays inline. A request is described by the schema's input, a response by its output with `additionalProperties: false`.
- The contract layer is `apps/backend/src/contract/`: a global `ContractValidationPipe` (`path: reason` messages; a missing body is `{}`; logs name paths, never values),
  a global `ContractSerializerInterceptor` that parses the result of every `@Responds` handler, the `standardSchemaConverter` (`z.toJSONSchema`, 2020-12 dialect for OpenAPI 3.1;
  refuses two schemas under one id), `createContractDocument(app)` and `mountContract`. The serializer stays on in production: a mismatch is a 500 in development and tests;
  in production it logs the paths and sends the result as it was.
- `@Fails({ 404: '...' })` documents the errors a handler throws, all with the shared `Problem` body; the document adds `401` to every operation but the public one and `400`
  to every operation that reads a body or a query. `@Streams(line, description, contentType?)` documents an NDJSON or SSE stream with its line schema; `@ApiConsumes` with a
  binary body describes uploads; `ThreadIdParam()` and `WorkspaceIdParam()` describe the shared path parameters. `@ApiOperation` and `@ApiTags` per domain are on every handler; `@Public()` also marks the operation as `security: []`.
- `GET /api/openapi.json` is a controller behind the bearer guard; Swagger UI is mounted at `/api/docs` only when `NODE_ENV=development`. The AG-UI endpoint (`@ApiExcludeController()`) and the development-only token route are not in the document.
- Secret fields carry `.meta({ secret: true })`; the document writes `writeOnly` / `x-secret`, and `redactSecrets(schema, value)` turns a marked field, and anything
  the schema does not describe, into `[secret]` before the pipe prints it. Query flags use `QueryFlagSchema` (`0`, `1`, `true`, `false`); nothing parses by hand.
- `pnpm run api:openapi` builds the backend, scans the application module with `preview: true` (nothing listens), writes `docs/api/openapi.yaml` and generates the SDK
  from it; `--check` compares the committed files against a fresh generation and the repository check runs it. Document and SDK are generated and reviewed, never
  hand-edited; generated files are committed, compiled and excluded from handwritten lint conventions.
- The renderer's HTTP SDK is `libs/shared/api` (`@pi-kit/api`): one backend contract, transport and authentication shared across domains. `@hey-api/openapi-ts` generates
  named operation functions, request and response models and its Fetch client; it replaces `openapi-typescript` and `openapi-fetch`. `ApiClient.client` is an authenticated
  instance passed explicitly to SDK operations; `BackendService` resolves its connection through `BACKEND_CONNECTION`; `unwrap` preserves backend Problem messages, transport errors
  and empty 204 responses. Binary transcription uses generated Blob bodies and SSE operations; NDJSON uses generated operations with `parseAs: 'stream'` and the common transport framer. AG-UI keeps its protocol lifecycle.
- Domain `api/` libraries are the public domain interfaces; domain `data/` libraries own stores, mapping and orchestration and call the generated operations directly with
  the authenticated client. There are no endpoint wrapper classes or `*.api.ts` proxies. The `layer:transport` tag forbids the shared API from depending on state or domain libraries.
- Renderer behaviour is configured at its owner: domain policy tokens for polling, retries, cache freshness and display budgets; `RENDERER_POLICY` for health, toasts and
  provider usage; `CONTEXT_POLICY` for chat and sidebar thresholds, with pure helpers taking thresholds as arguments; `IS_MAC` per injector; component inputs for editor
  highlighting, graph virtualisation, model-picker refresh and MCP frame height and polling (MCP idle timeout stays in `MCP_APPS_CONFIG`); `PK_TOOLTIP_DEFAULTS` with `pkTipDelay`
  per instance. A policy is overridden by spreading its exported `DEFAULT_*_POLICY`; an input is preferred when only one instance differs. Protocol identifiers, storage
  keys and algorithm constants stay ordinary constants; live user preferences belong in signals, not in token objects.
- `ChatStore` composes typed NgRx features (state, transcript, composer view, actions, agent events, connection lifecycle); `SettingsStore` composes state, actions and
  lifecycle, with its credential workflow owning its stream and cleanup. Public store methods and signals stay the component-facing interface.

## Consequences

- A renamed route, parameter or field breaks the build on both sides; a route change is one regeneration, and a drift between backend and committed SDK fails the check.
- A response is parsed, so a handler that returns more than its schema names loses the extra fields; a drift shows in the production log as paths.
- Requests are stricter: a flag that is not `0`, `1`, `true` or `false`, an out-of-range `limit` or a missing `?thread=` is a 400 with zod's sentence.
- Response validation costs about as much as the `JSON.stringify` Express does anyway; `docs/api/openapi.yaml` is the first thing an outside script reads.
- One transport, one authentication path and one error mapping for every domain; binary bodies and response narrowing move to the call site.
- Applications and tests change renderer timing and capacity through tokens and inputs instead of editing constants.
- `@nestjs/swagger` brings `swagger-ui-dist` into the backend's production closure although the UI is never mounted there; packaging can prune it.
- Nothing changes for pi: the backend's contract with pi stays the SDK.
