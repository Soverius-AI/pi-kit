import type { Translate } from '@pi-kit/i18n';
import {
  type ModelInfo,
  type ModelProvider,
  type ModelRef,
  type ProviderUsage,
  type ThinkingLevel,
  fuzzyScore,
  modelIdentity,
} from '@pi-kit/protocol';
import { groupProviders, providerFamily } from '@pi-kit/protocol';

/**
 * The pure parts of the model picker: the matcher, the sections (Pinned first, then one per provider), what pinning writes, the usage words of a section heading and the
 * level of the effort flask. No component and no store: the picker, the chips and the specs all read these.
 */

export const modelKey = (model: Pick<ModelInfo, 'provider' | 'id'>): string => modelIdentity(model.provider, model.id);

/** `*sonnet*` or `anthropic/*` style patterns match `provider/id` and the display name; plain text is a fuzzy match. */
export function matchModel(model: Pick<ModelInfo, 'provider' | 'id' | 'name'>, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const haystack = `${model.provider}/${model.id} ${model.name}`;
  if (q.includes('*')) {
    const pattern = new RegExp(
      `^${q
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
      'i',
    );
    return pattern.test(`${model.provider}/${model.id}`) || pattern.test(model.id) || pattern.test(model.name);
  }
  return fuzzyScore(q, haystack) >= 0;
}

// ---- sections

export interface PickerSection {
  /** `pinned` or `provider:<id>`. */
  key: string;
  kind: 'pinned' | 'provider';
  title: string;
  /** How the provider is signed in; absent for Pinned and for a provider the backend did not describe. */
  provider?: ModelProvider;
  models: ModelInfo[];
}

/** The pinned models that can be used now, in the order ⌘⇧M cycles them. */
export function pinnedModels(models: readonly ModelInfo[], pinned: readonly ModelRef[]): ModelInfo[] {
  return [
    ...new Map(
      pinned
        .flatMap((ref) => models.filter((m) => m.provider === ref.provider && m.id === ref.id))
        .map((model) => [modelKey(model), model]),
    ).values(),
  ];
}

/**
 * Pinned first (only the models that match, and always present without a search so the person sees what ⌘⇧M cycles), then one section per provider in the order the backend gave
 * (subscription, key, environment, local) with the models that are not pinned. A section with no match is left out. A model appears once.
 */
export function pickerSections(
  translate: Translate,
  input: {
    models: readonly ModelInfo[];
    providers: readonly ModelProvider[];
    pinned: readonly ModelRef[];
    query: string;
  },
): PickerSection[] {
  const { providers, pinned, query } = input;
  const models = [...new Map(input.models.map((model) => [modelKey(model), model])).values()];
  const matches = (model: ModelInfo): boolean =>
    matchModel(model, query) ||
    matchModel(
      {
        ...model,
        provider: providerFamily(providers.find((p) => p.id === model.provider) ?? { id: model.provider }).id,
      },
      query,
    );
  const pins = pinnedModels(models, pinned);
  const pinnedKeys = new Set(pins.map(modelKey));
  const searching = query.trim() !== '';
  const sections: PickerSection[] = [];
  const shownPins = pins.filter(matches);
  if (shownPins.length > 0 || !searching)
    sections.push({ key: 'pinned', kind: 'pinned', title: translate('chat.modelPicker.pinned'), models: shownPins });
  const ids = [
    ...providers.map((p) => p.id),
    ...[...new Set(models.map((m) => m.provider))].filter((id) => !providers.some((p) => p.id === id)).sort(),
  ];
  for (const group of groupProviders(
    ids.map((id): ModelProvider => providers.find((p) => p.id === id) ?? { id, name: id, kind: 'other' }),
  )) {
    const connectionIds = new Set(group.connections.map((p) => p.id));
    const list = models.filter((m) => connectionIds.has(m.provider) && !pinnedKeys.has(modelKey(m)) && matches(m));
    if (list.length === 0) continue;
    const first = group.connections[0];
    const address = [...new Set(group.connections.flatMap((p) => (p.address ? [p.address] : [])))].join(', ');
    const provider = { ...first, id: group.id, name: group.name, ...(address ? { address } : {}) };
    sections.push({
      key: `provider:${group.id}`,
      kind: 'provider',
      title: group.name,
      provider,
      models: list,
    });
  }
  return sections;
}

/** The rows in the order they are shown: what ↑ and ↓ walk. */
export const visibleModels = (sections: readonly PickerSection[]): ModelInfo[] => sections.flatMap((s) => s.models);

/** The letters of a section's tile: "A", "OR", "G"; a local server gets the house glyph in the template. */
export function tileLetters(name: string): string {
  const capitals = name.replace(/[^A-Z]/g, '');
  return capitals.length >= 2 ? capitals.slice(0, 2) : (name.trim()[0] ?? '?').toUpperCase();
}

export function stateChip(translate: Translate, kind: ModelProvider['kind']): string | undefined {
  switch (kind) {
    case 'subscription':
      return translate('chat.modelPicker.subscription');
    case 'api-key':
      return translate('chat.modelPicker.aPIKey');
    case 'environment':
      return translate('chat.modelPicker.env');
    case 'local':
      return translate('chat.modelPicker.local');
    default:
      return undefined;
  }
}

// ---- pinning

/** What `enabledModels` holds for one pinned model: `provider/id`, with pi's `:level` suffix when the pin carries a thinking level. */
export const pinPattern = (ref: ModelRef): string =>
  `${ref.provider}/${ref.id}${ref.thinkingLevel ? `:${ref.thinkingLevel}` : ''}`;

/**
 * The pinned set after the pin on a row was clicked: the model leaves it when it is in, joins at the end when it is not. The result is the explicit list pi stores (a glob pattern in
 * the setting is written out as the models it matched, once the person changes the set from here).
 */
export function togglePinned(pinned: readonly ModelRef[], model: Pick<ModelInfo, 'provider' | 'id'>): ModelRef[] {
  const has = pinned.some((p) => p.provider === model.provider && p.id === model.id);
  return has
    ? pinned.filter((p) => !(p.provider === model.provider && p.id === model.id))
    : [...pinned, { provider: model.provider, id: model.id }];
}

// ---- usage

const pct = (n: number): string => `${Math.round(n)} %`;

/** The pieces of the usage in a heading, in reading order: up to two windows ("38 % of 5 h", "12 % of week") and the credit ("credit $41.20"). */
export function providerUsageParts(translate: Translate, usage: ProviderUsage | null | undefined): string[] {
  if (!usage) return [];
  const parts = usage.windows
    .slice(0, 2)
    .map((w) => translate('chat.modelPicker.of', { value1: pct(w.used), value2: w.name }));
  if (usage.credit) parts.push(translate('chat.modelPicker.credit', { value1: usage.credit }));
  return parts;
}

/** "38 % of 5 h · 12 % of week", the credit as "credit $41.20", both when a provider gives both. */
export const providerUsageLine = (translate: Translate, usage: ProviderUsage | null | undefined): string =>
  providerUsageParts(translate, usage).join(' · ');

/** The first window as a bar: the share and whether it is getting full (80 % and more). */
export function providerUsageBar(usage: ProviderUsage | null | undefined): { used: number; warn: boolean } | undefined {
  const first = usage?.windows[0];
  return first ? { used: first.used, warn: first.used >= 80 } : undefined;
}

/** When a window resets, as a person says it: "14:30" today, "Thu 09:00" later. Empty when the time cannot be read. */
export function resetText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

/** The tooltip of the usage: every window with its share and reset time. */
export function providerUsageTip(
  translate: Translate,
  usage: ProviderUsage | null | undefined,
  now: Date = new Date(),
): string {
  if (!usage) return '';
  const windows = usage.windows.map(
    (w) =>
      `${w.name} ${pct(w.used)}${w.resets && resetText(w.resets, now) ? translate('chat.modelPicker.resets', { value1: resetText(w.resets, now) }) : ''}`,
  );
  return [
    ...windows,
    ...(usage.credit ? [translate('chat.modelPicker.creditLeft', { value1: usage.credit })] : []),
  ].join(' · ');
}

// ---- effort and the flask

/** How high the primary colour fills the bowl of the flask, in percent of its height, per level: the chip needs no word. */
export const FLASK_FILL: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  minimal: 15,
  low: 30,
  medium: 50,
  high: 65,
  xhigh: 80,
  max: 100,
};

/** The stroke of the flask: muted when off, the text colour for the low levels, the primary from high. */
export type FlaskStroke = 'muted' | 'base' | 'primary';

export function flaskStroke(level: ThinkingLevel): FlaskStroke {
  if (level === 'off') return 'muted';
  return level === 'minimal' || level === 'low' || level === 'medium' ? 'base' : 'primary';
}

/** "Effort: high (⌘⇧E cycles)" */
export const effortTip = (translate: Translate, level: ThinkingLevel): string =>
  translate('chat.modelPicker.effortECycles', { value1: level });
