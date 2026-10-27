/**
 * "Failing specs": a pi extension that answers with an A2UI surface instead of prose (pi-kit).
 *
 * The tool returns a fixed A2UI v0.9 payload in `details.a2ui_operations`. pi-kit's backend turns that into an
 * `a2ui-surface` activity in the transcript and the renderer draws it with its daisyUI catalog: a card with a
 * table of specs (a button per row) and a "Rerun all" button. Pressing a button sends the model a message that says
 * which action the user took ("User performed action "rerun_spec" on surface "failing-specs" ... Context: ...").
 *
 * Nothing here needs a remote agent or an LLM-generated UI: the model only decides when to call the tool. Ask it
 * "Which e2e specs fail right now?" or "Show the failing specs".
 *
 * Install it where pi looks for extensions, for example
 *   mkdir -p <project>/.pi/extensions && cp -r examples/a2ui-failing-specs <project>/.pi/extensions/
 * (a project extension loads once pi trusts the folder; for development PI_KIT_TRUSTED_CWDS=<project> does that
 * in pi-kit), or copy it to ~/.pi/agent/extensions/. See examples/README.md.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** The A2UI catalog pi-kit registers: the A2UI v0.9 basic catalog, restyled, plus `Table` and `Badge`. */
const CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json';
const SURFACE_ID = 'failing-specs';

const SPECS = [
  { spec: 'export.spec.ts:41', assertion: 'expected status "ready"' },
  { spec: 'export.spec.ts:58', assertion: 'PDF has 2 pages' },
  { spec: 'download.spec.ts:102', assertion: 'file name ends with .pdf' },
];

/** A2UI v0.9 messages, flat component list (children are referenced by id), data model separate. */
function failingSpecsSurface(specs: typeof SPECS): Record<string, unknown>[] {
  return [
    { version: 'v0.9', createSurface: { surfaceId: SURFACE_ID, catalogId: CATALOG_ID } },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: SURFACE_ID,
        components: [
          // The root card's title and badge become the bar above the surface in the transcript.
          { id: 'root', component: 'Card', child: 'body', title: 'Failing specs', badge: String(specs.length), badgeTone: 'error' },
          { id: 'body', component: 'Column', children: ['specs', 'rule', 'footer'] },
          {
            id: 'specs',
            component: 'Table',
            columns: [
              { key: 'spec', label: 'Spec', kind: 'code' },
              { key: 'assertion', label: 'Assertion' },
              { key: 'rerun', label: 'Rerun', kind: 'action', actionLabel: 'Run', event: 'rerun_spec', align: 'end' },
            ],
            rows: { path: '/specs' },
          },
          { id: 'rule', component: 'Divider' },
          // `inset` pads a container; layout components are flush by default so the table and the rule run edge to edge.
          { id: 'footer', component: 'Row', inset: true, justify: 'end', children: ['rerun-all'] },
          {
            id: 'rerun-all',
            component: 'Button',
            variant: 'primary',
            child: 'rerun-all-label',
            action: { event: { name: 'rerun_all', context: { count: specs.length } } },
          },
          { id: 'rerun-all-label', component: 'Text', text: `Rerun all ${specs.length}` },
        ],
      },
    },
    // A surface's data is an object: the table reads it at `/specs`. A bare array at `/specs` would still render, because
    // pi-kit rewrites it to this, but CopilotKit's renderer reveals a surface only once it has seen a data update whose value is an object.
    { version: 'v0.9', updateDataModel: { surfaceId: SURFACE_ID, path: '/', value: { specs } } },
  ];
}

export default function failingSpecs(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'show_failing_specs',
    label: 'Failing specs',
    description:
      'Shows the user a table of the failing e2e specs with a button to rerun each one. Call it when the user asks which specs fail. It needs no arguments.',
    promptSnippet: 'Show the failing e2e specs to the user as an interactive table',
    parameters: Type.Object({}),
    async execute() {
      const lines = SPECS.map((s) => `- ${s.spec}: ${s.assertion}`);
      return {
        content: [
          {
            type: 'text',
            text: `Showed the user a table of ${SPECS.length} failing specs with Run buttons:\n${lines.join('\n')}\nWait for the user to press a button; do not repeat the table in your answer.`,
          },
        ],
        // pi-kit reads `a2ui_operations` from `details`; the model only sees the text above.
        details: { a2ui_operations: failingSpecsSurface(SPECS) },
      };
    },
  });
}
