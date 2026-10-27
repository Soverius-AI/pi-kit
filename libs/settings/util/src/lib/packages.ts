import type { Translate } from '@pi-kit/i18n';
import {
  type PackageDetail,
  type PackageItem,
  type PackageSearchResult,
  bringsText,
  installCommand,
  originOfSource,
} from '@pi-kit/protocol';

/**
 * The rows of Settings › Extensions › Packages and the words of the “Add a package” wizard, as pure functions: what a row says about a package, how
 * a search result reads, and the step machine of the wizard (Browse / From git / From a folder, then what it adds and the command).
 */

const monthNames = (translate: Translate) => [
  translate('settings.packages.jan'),
  translate('settings.packages.feb'),
  translate('settings.packages.mar'),
  translate('settings.packages.apr'),
  translate('settings.packages.may'),
  translate('settings.packages.jun'),
  translate('settings.packages.jul'),
  translate('settings.packages.aug'),
  translate('settings.packages.sep'),
  translate('settings.packages.oct'),
  translate('settings.packages.nov'),
  translate('settings.packages.dec'),
];

/** "Oct 3", with the year when it is not this year's. */
export function shortDate(translate: Translate, ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${monthNames(translate)[date.getMonth()]} ${date.getDate()}${sameYear ? '' : ` ${date.getFullYear()}`}`;
}

/** "4 days ago", "2 weeks ago", "Oct 1" for anything older than two months; a date the registry gave as ISO text. */
export function agoText(translate: Translate, iso: string | undefined, now = Date.now()): string | undefined {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return undefined;
  const days = Math.floor((now - at) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return translate('settings.packages.daysAgo', { value1: days });
  if (days < 60) return translate('settings.packages.weeksAgo', { value1: Math.floor(days / 7) });
  return shortDate(translate, at, now);
}

/** 12034 -> "12k", 3100 -> "3.1k", 800 -> "800". */
export function downloadsText(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(Math.round(n / 100) / 10).toString()}k`;
  return String(n);
}

export const homeShort = (path: string, home?: string): string =>
  home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

/** How a package says where it comes from: `npm:name`, `git:github.com/…`, the folder, or “ships with pi-kit”. */
export function originText(
  translate: Translate,
  item: Pick<PackageItem, 'origin' | 'source' | 'path'>,
  home?: string,
): string {
  switch (item.origin) {
    case 'bundled':
      return translate('settings.packages.shipsWithPiKit');
    case 'folder': {
      // A long path keeps its last two folders (the row's tip has all of it).
      const path = homeShort(item.path ?? item.source, home);
      const parts = path.split('/');
      return path.length > 46 && parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path;
    }
    case 'git':
      return item.source.length > 46 ? `${item.source.slice(0, 22)}…${item.source.slice(-20)}` : item.source;
    default:
      return item.source;
  }
}

export interface PackageRow {
  id: string;
  item: PackageItem;
  name: string;
  /** The line under the name: what it brings, where it comes from, when it was installed. */
  parts: { brings: string; origin: string; originMono: boolean; installed?: string };
  originChip: 'npm' | 'git' | 'folder' | 'bundled';
  /** “0.4 → 0.5”, or the words for an update without versions. */
  outdated?: string;
  missing: boolean;
}

export function outdatedText(
  translate: Translate,
  item: Pick<PackageItem, 'outdated' | 'version'>,
): string | undefined {
  if (!item.outdated) return undefined;
  const from = item.outdated.current ?? item.version;
  return from && item.outdated.latest
    ? `${from} → ${item.outdated.latest}`
    : translate('settings.packages.updateAvailable');
}

export function packageRows(
  translate: Translate,
  items: readonly PackageItem[],
  home?: string,
  now = Date.now(),
): PackageRow[] {
  return items.map((item) => ({
    id: item.id,
    item,
    name: item.name,
    parts: {
      brings: bringsText(item.brings),
      origin: originText(translate, item, home),
      originMono: item.origin !== 'bundled',
      ...(item.installedAt
        ? {
            installed: translate('settings.packages.installed', {
              value1: shortDate(translate, item.installedAt, now),
            }),
          }
        : {}),
    },
    originChip: item.origin,
    ...(outdatedText(translate, item) ? { outdated: outdatedText(translate, item) as string } : {}),
    missing: !item.installed,
  }));
}

/** The header's chip: “2 of 3 on”. */
export function packagesOnText(translate: Translate, items: readonly PackageItem[]): string {
  return translate('settings.packages.ofOn', { value1: items.filter((i) => i.enabled).length, value2: items.length });
}

/** The header's line: “3 packages, 2 on, 1 update”. */
export function packagesSummary(translate: Translate, items: readonly PackageItem[]): string {
  if (items.length === 0) return translate('settings.packages.noPackagesYet');
  const on = items.filter((i) => i.enabled).length;
  const updates = items.filter((i) => i.outdated).length;
  return translate('settings.packages.on', {
    value1: items.length,
    value2: items.length === 1 ? translate('settings.packages.package') : translate('settings.packages.packages'),
    value3: on,
    value4:
      updates > 0
        ? `, ${updates} ${updates === 1 ? translate('settings.packages.update') : translate('settings.packages.updates')}`
        : '',
  });
}

/** The two lines a search result shows under its name. */
export function resultDetail(translate: Translate, result: PackageSearchResult, now = Date.now()): string {
  const parts: string[] = [];
  // What a package adds is said only when the registry's own manifest says it; keywords alone are a guess, which the row's chip ("skills only") carries.
  if (result.exact && result.brings) parts.push(bringsText(result.brings));
  if (result.downloads !== undefined)
    parts.push(translate('settings.packages.downloads', { value1: downloadsText(result.downloads) }));
  const updated = agoText(translate, result.updated, now);
  if (updated) parts.push(translate('settings.packages.updated', { value1: updated }));
  if (result.license) parts.push(result.license);
  return parts.join(' · ');
}

// ---- the wizard

export type PackageTab = 'browse' | 'git' | 'folder';
export type PackageStep = 'pick' | 'confirm';

export interface AddPackageState {
  tab: PackageTab;
  step: PackageStep;
  direction: 'forward' | 'back';
  query: string;
  kind: 'all' | 'extensions' | 'skills' | 'prompts' | 'themes';
  /** What was typed on From git and From a folder. */
  git: string;
  folder: string;
  /** The source the second step is about. */
  source: string;
  /** The result that was picked on Browse, for its downloads on the second step. */
  picked?: PackageSearchResult;
  /** “Enable for every project”: user scope; off is this project only. */
  everyProject: boolean;
}

export const startAddPackage = (tab: PackageTab = 'browse'): AddPackageState => ({
  tab,
  step: 'pick',
  direction: 'forward',
  query: '',
  kind: 'all',
  git: '',
  folder: '',
  source: '',
  everyProject: true,
});

export const setTab = (state: AddPackageState, tab: PackageTab): AddPackageState => ({
  ...state,
  tab,
  direction: 'forward',
});

/** A result of the search is picked: its source is what the second step shows. */
export const pickResult = (state: AddPackageState, result: PackageSearchResult): AddPackageState => ({
  ...state,
  step: 'confirm',
  direction: 'forward',
  source: result.source,
  picked: result,
});

/** “Continue” on From git or From a folder. */
export function continueTyped(state: AddPackageState): AddPackageState {
  const source = (state.tab === 'git' ? state.git : state.folder).trim();
  return source ? { ...state, step: 'confirm', direction: 'forward', source, picked: undefined } : state;
}

export const backToPick = (state: AddPackageState): AddPackageState => ({ ...state, step: 'pick', direction: 'back' });

/** What the person typed on From git, as a source `pi install` takes; undefined while it is not an address. */
export function gitSource(text: string): string | undefined {
  const s = text.trim();
  if (!s) return undefined;
  if (/^(github|gitlab|bitbucket)\.(com|org)\//.test(s)) return `git:${s}`;
  return originOfSource(s) === 'git' ? s : undefined;
}

export function canContinue(state: AddPackageState): boolean {
  if (state.step === 'confirm') return true;
  if (state.tab === 'browse') return false;
  return state.tab === 'git' ? gitSource(state.git) !== undefined : state.folder.trim() !== '';
}

export function footHint(translate: Translate, state: AddPackageState): string {
  return state.step === 'pick'
    ? translate('settings.packages.step1Of2NextWhatIt')
    : translate('settings.packages.step2Of2');
}

export const primaryText = (translate: Translate, state: AddPackageState): string =>
  state.step === 'pick' ? translate('settings.packages.continue') : translate('settings.packages.install');

/** The command the second step says it will run. */
export function commandOf(state: AddPackageState, detail: Pick<PackageDetail, 'source'> | undefined): string {
  return installCommand(detail?.source ?? state.source, state.everyProject ? 'user' : 'project');
}
