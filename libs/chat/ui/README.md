# chat-ui

`@pi-kit/chat/ui`, library type `type:ui` of the `chat` domain (tags `scope:chat`, `type:ui`).

Presentational components: inputs and outputs, no feature-domain store or HTTP orchestration. Shared theme and translation services provide presentation preferences. May use `ui`, `util` and `scope:shared`.

The boundary rules are in `eslint.config.mjs` at the repository root; `doc/docs/structure.md` has the tree and the rule per type.

## Rich Markdown

`Prose` is the assistant-message Markdown slot and can also render outside chat messages. It keeps the streaming caret and a 400-entry completed-document LRU cache. Marked parses Markdown; highlight.js colors code with lazy uncommon grammars; code controls copy the original source. Streaming completion is applied only to inline prose, never to fenced source.

KaTeX renders `$...$` inline and `$$...$$` display math. Trust is disabled, expansion/size/nesting are bounded, and rendering failures degrade to readable text. Generated Markdown/math goes through a private DOMPurify instance into a DOM fragment; raw model HTML remains escaped text. The sanitized tree is mounted without a trusted-HTML bypass or serialize/reparse cycle.

Fenced `mermaid` blocks lazy-load Mermaid and render as isolated, sanitized SVG images. Flowcharts, sequence/class/state/ER diagrams and Gantt charts use standard syntax. During streaming, the renderer tries valid line prefixes on a throttled single-in-flight schedule, retains the last valid image, and validates the exact source when the real fence closes. Sources and rendered images are bounded; an LRU reuses source/theme results. Diagram/Source controls retain access to the definition and its copy action. Inline previews fit a bounded fraction of the visible chat above its floating composer, resizing with the viewport rather than stretching long messages. A root-owned full-window CDK viewer lives outside the virtualized row, with fit/zoom/scroll-to-pan controls and Escape/focus restoration. It follows live images while the source is mounted; if virtualization or end-of-run id reconciliation replaces the source, the viewer remains open as an explicitly labelled snapshot until the user closes it. SVG downloads preserve the sanitized vector; PNG downloads rasterize the same snapshot at up to 2× viewBox resolution on the captured theme background, bounded to 16 MP / 8192 px. Object URLs are revoked after download and decode/encoding failures stay local to the diagram. Dark/light changes rerender diagrams.

Untrusted diagrams cannot configure the renderer, execute interactions, load images/icons/resources, supply sequence properties/details, or inject custom CSS. Directives, frontmatter, extended node metadata, callbacks and CSS resources are rejected **before** Mermaid runs; style declarations, sequence links/properties/details and class-diagram links/callbacks are rejected after `mermaid.parse` reports the diagram type (so a Gantt task or mindmap node named "Style guide" stays text) but **before** layout: output sanitization alone cannot prevent resources fetched during layout. HTML labels are disabled. The desktop CSP is unchanged.

Agent-facing syntax, type-selection guidance, examples and restrictions live in `apps/backend/src/assets/skills/pi-ui/SKILL.md`; `genui-extension.ts` advertises native Markdown/math/diagrams even when generated UI tools are disabled.

Verify with `pnpm exec nx test chat-ui --watch=false`, `pnpm exec nx lint chat-ui`, and `pnpm exec nx build renderer`. `e2e/markdown.e2e.mjs` uses a deterministic fake model to test source copying, math, the actual skill examples, progressive SVG updates, theme/cold hydration, invalid-source fallback and strict CSP behavior.
