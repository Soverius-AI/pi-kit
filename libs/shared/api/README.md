# Backend API

`@pi-kit/api` is the renderer's transport boundary. It contains the OpenAPI-generated
operation functions, request/response models, authenticated `ApiClient`, backend
connection provider and explicit NDJSON support. It never imports stores or domains
(`layer:transport`, enforced by ESLint).

```ts
import { ApiClient, threadsList, unwrap } from '@pi-kit/api';

const client = inject(ApiClient).client;
const threads = await unwrap(threadsList({ client, query: { workspace: cwd } }));
```

Pass the injected client to every generated operation. The generated default client
has no desktop connection or bearer token. Domain facades handle orchestration and
mapping; they do not repeat HTTP paths. Domain `api/` libraries remain public domain
interfaces, separate from this HTTP SDK.

Run `pnpm run api:openapi` after changing backend routes or protocol schemas. It
builds the document and SDK using the pinned generator and `openapi-ts.config.mjs`.
Never edit `src/generated/`. `pnpm run check` compares the document and every SDK
file, including the file list, with fresh temporary output.

`BACKEND_CONNECTION` supplies endpoint/token resolution. `createBackendConnection`
can run before Angular bootstrap and the same connection is then provided to the
application. Electron credentials remain dynamic; 401 clears stale browser storage.

Binary transcription uses generated operations with Blob bodies. SSE/NDJSON and
AG-UI keep explicit adapters for framing, lifecycle and protocol handling.
