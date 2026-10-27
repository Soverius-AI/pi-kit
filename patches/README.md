# Pinned SDK adaptations

pnpm applies these patches during installation. They are scoped to the exact versions in
`pnpm-workspace.yaml`; dependency upgrades must revalidate or remove them.

- `@copilotkit/angular`: use Zod 4's native JSON Schema conversion, share highlight.js's common
  language registry, and replace embedded KaTeX font data with local font asset URLs. The font
  replacements match the original bytes to KaTeX 0.16.47 files; browser font loading fetches only
  the faces needed by rendered math. The patch is large because upstream embeds the font bytes
  in two single-line component style declarations.
- `@copilotkit/core`: use Zod 4's native JSON Schema conversion in ESM and CommonJS builds,
  and retain explicitly supplied local agents when runtime discovery reports the same id. This
  keeps pi-kit's hydration/cache transport in place rather than replacing it with a default proxy.
- `@a2ui/web_core`: supply explicit string keys to record schemas, migrate schema behavior
  introspection to Zod 4's tags and shape/element accessors, and use its native schema conversion.
- `@ag-ui/client`: raise the SSE parser's buffer limit from 10 MB to 512 MB. The client errors with
  "SSE buffer size exceeded maximum limit" when one event is larger than the limit, and a thread's
  history snapshot (`MESSAGES_SNAPSHOT`, the hydration event) is one event: a long thread with large
  tool outputs passed 10 MB and could not be opened. The backend and the renderer share a machine, so
  the larger buffer costs nothing on the wire.
- `zod-to-json-schema`: route Zod 4 schemas to the native converter while retaining compatibility
  for schemas supplied by older external clients.

The dependency graph pins every Zod dependency to 4.6.7. Application imports use its current
API. External SDK compatibility code may use that package's `zod/v3` export; it does not install
another Zod version or another package copy.

Nx hashes overrides and patch files as shared inputs.

`node --test scripts/dependency-contract.spec.mjs` checks shared package resolution, schema
conversion, A2UI records and external font references. The production browser tests verify
that ordinary chat does not request KaTeX fonts and that requesting a math face loads a local
asset under the desktop CSP. Uncommon syntax grammars load on demand and invalidate cached
markdown through the shared grammar revision.
