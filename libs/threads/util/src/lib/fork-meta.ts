import type { Translate } from '@pi-kit/i18n';
/** The sidebar's "2 forks" (nothing for a straight session). */
export function forkMeta(translate: Translate, forkCount: number): string | undefined {
  if (forkCount <= 0) return undefined;
  return translate(`common.forks.${forkCount === 1 ? 'one' : 'other'}`, { count: forkCount });
}
