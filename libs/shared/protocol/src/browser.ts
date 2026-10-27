import { z } from 'zod';

export type BrowserFailureCode = 'invalid' | 'unavailable' | 'timeout' | 'cancelled' | 'failed';

export const ScreenshotFormatSchema = z.enum(['jpeg', 'png']);
export const ScreenshotQualitySchema = z.number().int().min(0).max(100);
export const DEFAULT_SCREENSHOT_FORMAT = 'jpeg' as const;
export const DEFAULT_SCREENSHOT_QUALITY = 80;

/** Meaning survives the desktop IPC boundary; transport layers choose their own status codes. */
export class BrowserOperationError extends Error {
  constructor(readonly code: BrowserFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BrowserOperationError';
  }
}

/** One browser artifact belongs to one chat. Only HTTP(S) pages run in its isolated desktop browser. */
export const BrowserActionSchema = z.object({
  action: z.enum(['navigate', 'snapshot', 'click', 'fill', 'press', 'scroll', 'evaluate', 'screenshot', 'inspect', 'console', 'clear-console', 'back', 'forward', 'reload', 'close']),
  url: z.string().max(8192).optional().describe('HTTP(S) URL for navigate, including localhost dev servers.'),
  ref: z.string().max(80).optional().describe('Element reference from the most recent snapshot, required for click and fill.'),
  text: z.string().max(100_000).optional().describe('Text for fill.'),
  key: z.string().max(80).optional().describe('Key for press: Enter, Tab, Escape, ArrowDown, etc.'),
  deltaY: z.number().min(-100_000).max(100_000).optional().describe('Vertical pixels for scroll.'),
  code: z.string().max(100_000).optional().describe('JavaScript expression for evaluate; executes only inside this browser page.'),
  enabled: z.boolean().optional().describe('Start or cancel native element picking for inspect without a ref.'),
  scope: z.enum(['viewport', 'fullpage', 'selection']).optional().describe('Screenshot area; selection requires a current inspected element.'),
  format: ScreenshotFormatSchema.optional().describe('Screenshot format. Defaults to the saved inspector preference, or JPEG. PNG is lossless.'),
  quality: ScreenshotQualitySchema.optional().describe('JPEG quality, 0–100. Defaults to the saved inspector preference, or 80. Ignored for PNG.'),
  documentId: z.string().max(80).optional().describe('Reject context requests if navigation has changed the document.'),
}).superRefine((value, ctx) => {
  const required = value.action === 'navigate' ? ['url'] : value.action === 'click' ? ['ref'] : value.action === 'fill' ? ['ref', 'text'] : value.action === 'press' ? ['key'] : value.action === 'evaluate' ? ['code'] : value.action === 'scroll' ? ['deltaY'] : [];
  for (const key of required) if (value[key as keyof typeof value] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required for ${value.action}.` });
});
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const BrowserInspectionSchema = z.object({
  ref: z.string().max(80),
  documentId: z.string().max(80),
  selector: z.string().max(1000),
  tag: z.string().max(80),
  name: z.string().max(500),
  role: z.string().max(80),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  styles: z.record(z.string().max(80), z.string().max(200)),
}).meta({ id: 'BrowserInspection' });
export type BrowserInspection = z.infer<typeof BrowserInspectionSchema>;

export const BrowserLogSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  time: z.number(),
  level: z.enum(['debug', 'info', 'warning', 'error']),
  message: z.string().max(2000),
  source: z.string().max(1000).optional(),
  line: z.number().optional(),
});
export type BrowserLog = z.infer<typeof BrowserLogSchema>;

export const BrowserStateSchema = z.object({
  available: z.boolean(),
  threadId: z.string(),
  open: z.boolean(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  error: z.string().optional(),
  documentId: z.string().optional(),
  inspecting: z.boolean().optional(),
  inspection: BrowserInspectionSchema.optional(),
  consoleCount: z.number().optional(),
}).meta({ id: 'BrowserState' });
export type BrowserState = z.infer<typeof BrowserStateSchema>;

export const BrowserResultSchema = z.object({
  state: BrowserStateSchema,
  text: z.string().optional(),
  screenshot: z.object({ data: z.string(), mimeType: z.enum(['image/png', 'image/jpeg']) }).optional(),
  logs: z.array(BrowserLogSchema).max(100).optional(),
}).meta({ id: 'BrowserResult' });
export type BrowserResult = z.infer<typeof BrowserResultSchema>;

/** Layout is the only browser operation exposed directly to the trusted renderer's preload. */
export const BrowserViewportSchema = z.object({
  owner: z.string().min(1).max(100),
  threadId: z.string().min(1).max(100),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0) }).nullable(),
});
export type BrowserViewport = z.infer<typeof BrowserViewportSchema>;

export function emptyBrowserState(threadId: string, available: boolean): BrowserState {
  return { threadId, available, open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
}
