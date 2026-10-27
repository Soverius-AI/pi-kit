import type { Translate } from '@pi-kit/i18n';
import { canonicalCombo, findConflicts, isValidPiKey } from './keys';

/**
 * pi-kit's own shortcuts: the ones the window handles itself and the user can change. The combination is spelled with `mod`
 * (⌘ on a Mac, Ctrl elsewhere). Changed ones are kept in pi-kit's database as `{ id: combination }`; an id not in it has the default here.
 */
export interface PkShortcut {
  id: string;
  label: string;
  default: string;
}

export const kitShortcuts = (translate: Translate): readonly PkShortcut[] => [
  { id: 'new-thread', label: translate('shared.shortcuts.newThread'), default: 'mod+n' },
  // the new-thread page with the Where row showing Worktree.
  { id: 'new-worktree-thread', label: translate('shared.shortcuts.newThreadInAWorktree'), default: 'mod+shift+n' },
  { id: 'command-palette', label: translate('shared.shortcuts.commandPalette'), default: 'mod+k' },
  // the sidebar's search field. ⌘K is the palette's (and stays), so the field has its own key.
  { id: 'search-threads', label: translate('shared.shortcuts.searchThreadsInTheSidebar'), default: 'mod+shift+k' },
  { id: 'cycle-model', label: translate('shared.shortcuts.switchToTheNextPinnedModel'), default: 'mod+shift+m' },
  { id: 'cycle-effort', label: translate('shared.shortcuts.switchToTheNextEffortLevel'), default: 'mod+shift+e' },
  { id: 'files-filter', label: translate('shared.shortcuts.filterTheFilesPanel'), default: 'mod+shift+f' },
  { id: 'push-to-talk', label: translate('shared.shortcuts.pushToTalkDictateIntoTheMessage'), default: 'alt+space' },
  // threads of the open project, in the order the sidebar lists them.
  { id: 'prev-thread', label: translate('shared.shortcuts.previousThreadInThisProject'), default: 'mod+[' },
  { id: 'next-thread', label: translate('shared.shortcuts.nextThreadInThisProject'), default: 'mod+]' },
  { id: 'toggle-sidebar', label: translate('shared.shortcuts.showOrHideTheSidebar'), default: 'mod+b' },
];

/** Keys the window handles that cannot be changed; they still count when a new shortcut is checked for conflicts. */
export const fixedShortcuts = (
  translate: Translate,
): readonly { id: string; label: string; keys: readonly string[] }[] => [
  { id: 'stop', label: translate('shared.shortcuts.stopTheRunOrCloseAMenu'), keys: ['escape'] },
  { id: 'send', label: translate('shared.shortcuts.sendTheMessage'), keys: ['enter'] },
  { id: 'new-line', label: translate('shared.shortcuts.newLineInTheMessage'), keys: ['shift+enter'] },
  { id: 'recall', label: translate('shared.shortcuts.inAnEmptyComposerBringBackYour'), keys: ['up'] },
  {
    id: 'jump-project',
    label: translate('shared.shortcuts.jumpToThe1stTo9thProject'),
    keys: ['mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9'],
  },
];

/** The combination in effect for every editable shortcut: the saved one, else the default. Unusable saved text falls back to the default. */
export function resolveShortcuts(
  translate: Translate,
  saved: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const shortcut of kitShortcuts(translate)) {
    const combo = canonicalCombo(saved?.[shortcut.id] ?? '');
    out[shortcut.id] = combo && isValidPiKey(combo) ? combo : (canonicalCombo(shortcut.default) as string);
  }
  return out;
}

/** What the editor checks a shortcut against: the other editable ones and the fixed ones. */
export function shortcutBindings(
  translate: Translate,
  resolved: Readonly<Record<string, string>>,
): { id: string; keys: string[] }[] {
  return [
    ...kitShortcuts(translate).map((s) => ({ id: s.id, keys: [resolved[s.id] ?? s.default] })),
    ...fixedShortcuts(translate).map((s) => ({ id: s.id, keys: [...s.keys] })),
  ];
}

/** Which editable shortcuts share a key with another shortcut. */
export function shortcutConflicts(
  translate: Translate,
  resolved: Readonly<Record<string, string>>,
): Map<string, string[]> {
  return findConflicts(shortcutBindings(translate, resolved));
}

export function shortcutLabel(translate: Translate, id: string): string {
  return (
    kitShortcuts(translate).find((s) => s.id === id)?.label ??
    fixedShortcuts(translate).find((s) => s.id === id)?.label ??
    id
  );
}

/** Only the entries that differ from the default (what is worth saving). */
export function changedShortcuts(
  translate: Translate,
  resolved: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of kitShortcuts(translate))
    if (resolved[s.id] && resolved[s.id] !== canonicalCombo(s.default)) out[s.id] = resolved[s.id] as string;
  return out;
}
