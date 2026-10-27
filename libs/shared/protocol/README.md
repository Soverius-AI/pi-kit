# shared-protocol

The wire contract between the backend and the renderer: zod schemas (and their types) for every REST route, the AG-UI custom
events and activities pi-kit adds, interrupts and resume payloads, and the plugin API. Pure helpers both sides share live here
too (fuzzy matching, the diff model, redaction, secret marks, file badges). The OpenAPI document and `@pi-kit/api` are
generated from the backend's routes and these schemas (`pnpm run api:openapi`). Tags `scope:shared`, `type:util`; alias `@pi-kit/protocol`.
