import type { Translate } from '@pi-kit/i18n';
import { compactNumber } from './thinking';

/** The effort levels as pi names them (`off ... max`); pi-kit adds no names of its own. */
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

interface PricedModel {
  provider: string;
  contextWindow: number;
  costInput?: number | undefined;
  costOutput?: number | undefined;
}

const usd = (n: number): string => `$${n >= 10 ? Math.round(n) : Math.round(n * 100) / 100}`;

/** `$3 in / $15 out per 1M`, or `free` for a model with no price (a local one). */
export function priceLabel(translate: Translate, model: Pick<PricedModel, 'costInput' | 'costOutput'>): string {
  const input = model.costInput ?? 0;
  const output = model.costOutput ?? 0;
  if (input === 0 && output === 0) return translate('shared.models.free');
  return translate('shared.models.inOutPer1M', { value1: usd(input), value2: usd(output) });
}

/** The second line of a model row: `llama-swap · 262k context · free`. */
export function modelDetail(translate: Translate, model: PricedModel): string {
  return [
    model.provider,
    translate('shared.models.context', { value1: compactNumber(model.contextWindow) }),
    priceLabel(translate, model),
  ].join(' · ');
}
