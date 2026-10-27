import { z } from 'zod';

export const OPEN_GENERATIVE_UI_ACTIVITY = 'open-generative-ui';
export const OPEN_GENERATIVE_UI_TOOL = 'generateSandboxedUi';
export const GENUI_SANDBOX_PATH = '/api/genui-sandbox/frame.html';

export const A2UI_COMPONENTS = ['Row', 'Column', 'Card', 'Text', 'Image', 'Icon', 'Video', 'AudioPlayer', 'List', 'Tabs', 'Divider', 'Modal', 'Button', 'TextField', 'CheckBox', 'ChoicePicker', 'Slider', 'DateTimeInput', 'Badge', 'Table'] as const;

/** A complete surface. pi-kit supplies the framed root Card and the v0.9 envelope. */
export const RenderA2uiSchema = z.object({
  surfaceId: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  body: z.string().min(1).describe('Id of the component placed inside the root Card. Do not use the reserved id root.'),
  components: z.array(z.object({
    id: z.string().min(1),
    component: z.enum(A2UI_COMPONENTS),
    properties: z.record(z.string(), z.json()).describe('A2UI v0.9 properties, e.g. children, text, columns, rows, action. No id or component keys.'),
  }).strict()).min(1).max(500),
  data: z.record(z.string(), z.json()).describe('Object at data-model path /. Bind properties with { path: "/key" }.'),
}).strict();

/** Matches CopilotKit's generateSandboxedUi arguments; property order allows incremental rendering. */
export const GenerateSandboxedUiSchema = z.object({
  initialHeight: z.number().int().min(100).max(2000).optional(),
  placeholderMessages: z.array(z.string()).max(10).optional(),
  css: z.string().max(100_000).optional(),
  html: z.string().min(1).max(1_000_000).describe('Complete HTML document with <head> and <body>. Render inline in chat; no file is needed.'),
  jsFunctions: z.string().max(200_000).optional(),
  jsExpressions: z.array(z.string().max(200_000)).max(100).optional(),
}).strict();

export function openGenerativeUiContent(args: z.infer<typeof GenerateSandboxedUiSchema>) {
  return {
    initialHeight: args.initialHeight ?? 400,
    generating: false,
    css: args.css ?? '', cssComplete: true,
    html: [args.html], htmlComplete: true,
    jsFunctions: args.jsFunctions ?? '', jsFunctionsComplete: true,
    jsExpressions: args.jsExpressions ?? [], jsExpressionsComplete: true,
  };
}

/** Completed result payload; the live stream uses CopilotKit's middleware and this same activity id. */
export function openGenerativeUiOf(details: unknown): ReturnType<typeof openGenerativeUiContent> | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const args = GenerateSandboxedUiSchema.safeParse((details as Record<string, unknown>)['open_generative_ui']);
  return args.success ? openGenerativeUiContent(args.data) : undefined;
}
