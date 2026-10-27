/**
 * Pure helpers for generated UI in the transcript: what the bar above an A2UI surface or an MCP App
 * says. No Angular, no state.
 */

import type { Translate } from '@pi-kit/i18n';
export type GenUiTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export interface SurfaceHeader {
  title: string;
  badge?: string;
  tone: GenUiTone;
}

const TONES = new Set<string>(['success', 'warning', 'error', 'info', 'neutral']);

/** The `Card` props the bar reads: plain strings as an agent writes them (a title bound to data does not come through as one). */
export type CardHeaderProps = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * The bar of an A2UI surface, from the props of its root `Card` (the catalog's `Card` is the frame): `title`, `badge` and
 * `badgeTone` when they are plain strings, else a generic title. The surface cannot change the label on the right of the bar, which
 * says where the UI comes from; only this text is up to the agent.
 */
export function a2uiCardHeader(translate: Translate, props: CardHeaderProps | undefined): SurfaceHeader {
  const title = text(props?.['title']);
  const badge = text(props?.['badge']);
  const badgeTone = props?.['badgeTone'];
  const tone = typeof badgeTone === 'string' && TONES.has(badgeTone) ? (badgeTone as GenUiTone) : 'neutral';
  return { title: title ?? translate('chat.genui.generatedUI'), ...(badge ? { badge } : {}), tone };
}

/** The tool of an MCP App as a short phrase: `open_issue_form` becomes "open issue form". */
export function mcpToolLabel(tool: string | undefined): string | undefined {
  const label = tool?.replace(/[_-]+/g, ' ').trim();
  return label ? label : undefined;
}
