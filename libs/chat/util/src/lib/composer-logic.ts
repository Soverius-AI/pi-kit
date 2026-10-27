import type { Translate } from '@pi-kit/i18n';
import type { PkMenuGroup, PkMenuItem } from '@pi-kit/design-system';
import {
  type Command,
  type CommandSource,
  type ComposerChip,
  ComposerChipsSchema,
  MAX_COMPOSER_CHIPS,
  fuzzyFilter,
} from '@pi-kit/protocol';

/**
 * The pure parts of the composer: what the text before the caret asks for, the command menu's
 * groups, the `@paths` of a message and the image helpers. No Angular; `ChatStore` and the textarea slot use them.
 */

/** Image attachments have no application byte cap; providers may enforce their own constraints. */
export const MAX_IMAGE_BYTES = Infinity;

const commandGroupLabels = (translate: Translate): { source: CommandSource; title: string }[] => [
  { source: 'skill', title: translate('chat.composerLogic.skills') },
  { source: 'prompt', title: translate('chat.composerLogic.promptTemplates') },
  { source: 'extension', title: translate('chat.composerLogic.extensions') },
  { source: 'builtin', title: translate('chat.composerLogic.builtIn') },
];

/** Built-in command identifiers stay executable; only their presentation is localized. */
const LOCALIZED_COMMANDS = new Set([
  'settings',
  'model',
  'tree',
  'thinking',
  'scoped-models',
  'export',
  'import',
  'share',
  'bug',
  'copy',
  'name',
  'session',
  'cost',
  'changelog',
  'hotkeys',
  'fork',
  'clone',
  'trust',
  'login',
  'logout',
  'new',
  'compact',
  'resume',
  'reload',
  'quit',
  'llama',
  'setup',
  'connect',
  'project',
  'worktree',
  'attendant',
]);
const commandOrigin = (translate: Translate, origin: string | undefined): string | undefined =>
  origin === 'user' || origin === 'project' ? translate(`common.scope.${origin}`) : origin;

/** What the badge of a command says (doc/docs/design-system.md, "Command menu"). */
function badge(translate: Translate, command: Command): { text: string; className: string } {
  switch (command.source) {
    case 'skill':
      return {
        text: commandOrigin(translate, command.origin) ?? translate('chat.composerLogic.skillType'),
        className: 'badge-info badge-outline',
      };
    case 'prompt':
      return { text: translate('chat.composerLogic.template'), className: 'badge-secondary badge-outline' };
    case 'extension':
      return {
        text: commandOrigin(translate, command.origin) ?? translate('chat.composerLogic.extensionType'),
        className: 'badge-outline',
      };
    default:
      return {
        text: command.disabled ? translate('chat.composerLogic.notYet') : translate('chat.composerLogic.builtIne0d0c'),
        className: 'badge-ghost',
      };
  }
}

export function commandItem(translate: Translate, command: Command): PkMenuItem {
  const { text, className } = badge(translate, command);
  const description =
    (command.source === 'builtin' && LOCALIZED_COMMANDS.has(command.name)) ||
    (command.name === 'mcp' && command.kind === 'action')
      ? translate(`chat.commands.${command.name}.description`)
      : command.description;
  return {
    id: command.name,
    name: `/${command.name}`,
    description: [command.argumentHint, description].filter(Boolean).join('  '),
    badge: text,
    badgeClass: className,
    ...(command.disabled ? { disabled: true, title: command.disabledReason } : {}),
  };
}

/** The commands as menu groups, in the fixed group order, best match first inside each group. */
export function commandGroups(translate: Translate, commands: readonly Command[], query: string): PkMenuGroup[] {
  const q = query.replace(/^\//, '').trim().toLowerCase();
  // Names that contain what was typed come first (and alone, if there are any); the looser fuzzy match
  // (the letters in order) is the fallback, or `se` would list every skill with an s and an e in it.
  const contains = q ? commands.filter((c) => c.name.toLowerCase().includes(q)) : [...commands];
  const matching =
    q && contains.length === 0 ? fuzzyFilter([...commands], q, (c) => c.name) : fuzzyFilter(contains, q, (c) => c.name);
  return commandGroupLabels(translate)
    .map(({ source, title }) => ({
      title,
      items: matching.filter((c) => c.source === source).map((c) => commandItem(translate, c)),
    }))
    .filter((g) => g.items.length > 0);
}

/** The `@path` tokens of a message, without the `@`. */
export function fileRefsOf(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)@(\S+)/g)].map((m) => m[1].replace(/[.,;:!?)]+$/, '')).filter(Boolean);
}

/** The text without the first `@path` token and the space that follows it (or, at the end, the one before it): what removing a file chip does to the draft. */
export function withoutFileRef(text: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`(^|\\s)@${escaped}(?=[\\s.,;:!?)]|$)`).exec(text);
  if (!found) return text;
  let start = found.index + found[1].length;
  let end = start + 1 + path.length;
  if (/\s/.test(text[end] ?? '')) end += 1;
  else if (found[1]) start -= 1;
  return text.slice(0, start) + text.slice(end);
}

/** The leading `/name` and the rest of a slash message, or `undefined` when the text is not a slash message. */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1], args: m[2] ?? '' } : undefined;
}

/** The base64 of a file, without the `data:` prefix. */
export function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---- skill and prompt-template chips

/** The identity of a chip: each skill or template is on a message once. */
export const chipKey = (chip: Pick<ComposerChip, 'kind' | 'name'>): string => `${chip.kind}:${chip.name}`;

/** The chip a skill or prompt template command stands for (`skill:pdf-tools` is the skill `pdf-tools`); undefined for the other kinds of command. */
export function chipOfCommand(command: Pick<Command, 'name' | 'source' | 'origin'>): ComposerChip | undefined {
  if (command.source === 'skill')
    return {
      kind: 'skill',
      name: command.name.replace(/^skill:/, ''),
      pinned: false,
      ...(command.origin ? { scope: command.origin } : {}),
    };
  if (command.source === 'prompt')
    return { kind: 'prompt', name: command.name, pinned: false, ...(command.origin ? { scope: command.origin } : {}) };
  return undefined;
}

/** The chips with `chip` added at the end, or the same list when it is already there (or the message is full). */
export function withChip(chips: readonly ComposerChip[], chip: ComposerChip): readonly ComposerChip[] {
  if (chips.some((c) => chipKey(c) === chipKey(chip)) || chips.length >= MAX_COMPOSER_CHIPS) return chips;
  return [...chips, chip];
}

/** The chips without `chip`. */
export const withoutChip = (
  chips: readonly ComposerChip[],
  chip: Pick<ComposerChip, 'kind' | 'name'>,
): readonly ComposerChip[] => chips.filter((c) => chipKey(c) !== chipKey(chip));

/** The chips with the pin of `chip` flipped. */
export const withPinToggled = (
  chips: readonly ComposerChip[],
  chip: Pick<ComposerChip, 'kind' | 'name'>,
): readonly ComposerChip[] => chips.map((c) => (chipKey(c) === chipKey(chip) ? { ...c, pinned: !c.pinned } : c));

/** What stays in the composer after a message went: the pinned chips. */
export const pinnedChips = (chips: readonly ComposerChip[]): readonly ComposerChip[] => chips.filter((c) => c.pinned);

/** The draft without the `/query` the menu completed (from `start` to the caret); the spaces that followed it go too, so no gap is left. */
export function withoutSlashToken(text: string, start: number, caret: number): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(caret);
  return { text: before + (before === '' || /\s$/.test(before) ? after.replace(/^[ \t]+/, '') : after), caret: start };
}

/** The pinned chips saved per thread (`localStorage`), validated; anything unreadable is dropped. */
export function readPinnedChips(raw: string | null): Record<string, ComposerChip[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, ComposerChip[]> = {};
    for (const [thread, chips] of Object.entries(parsed)) {
      const valid = ComposerChipsSchema.safeParse(chips);
      if (valid.success) out[thread] = valid.data.map((c) => ({ ...c, pinned: true }));
    }
    return out;
  } catch {
    return {};
  }
}
