/**
 * Key combinations for the keybinding editor. Two scopes use the same spelling, `modifier+modifier+key`:
 *
 * - pi's terminal interface (docs/keybindings.md of pi): `ctrl`, `shift`, `alt`, `super`, keys such as `escape`, `pageUp`, `f5`, `ctrl+shift+x`.
 * - pi-kit's window: the same, plus `mod`, which is ⌘ on macOS and Ctrl elsewhere, so a saved shortcut means the same on every machine.
 *
 * A combination is compared in its canonical spelling (modifiers sorted, key lower-cased, aliases resolved), so `shift+ctrl+p` and `ctrl+shift+P`
 * are the same combination and conflict detection is plain equality.
 */

const MODIFIER_ORDER = ['mod', 'ctrl', 'alt', 'shift', 'super'] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  cmd: 'super',
  meta: 'super',
  win: 'super',
  option: 'alt',
  control: 'ctrl',
  pgup: 'pageup',
  pgdn: 'pagedown',
  ' ': 'space',
  spacebar: 'space',
};

/** Canonical spelling; `undefined` for text that has no key in it (empty, only modifiers). */
export function canonicalCombo(text: string): string | undefined {
  const trimmed = text.trim();
  // The plus key itself: "+" or "ctrl++".
  let key: string | undefined = trimmed === '+' || trimmed.endsWith('++') ? '+' : undefined;
  const rest = key ? trimmed.replace(/\+?\+$/, '') : trimmed;
  const mods = new Set<string>();
  for (const raw of rest.split('+').filter(Boolean)) {
    const lower = raw.trim().toLowerCase();
    const name = ALIASES[lower] ?? lower;
    if (MODIFIERS.has(name)) mods.add(name);
    else key = name;
  }
  if (!key) return undefined;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** The key part of a keyboard event, in the spelling of the docs (`up`, `escape`, `pageup`, `f5`, `m`). */
function eventKey(event: Pick<KeyEventLike, 'key' | 'code'>): string | undefined {
  const { key, code } = event;
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Dead', 'CapsLock', 'Process'].includes(key))
    return undefined;
  // With ⌥ held a Mac types symbols (⌥M is µ); the physical key is what the user means.
  if (/^Key[A-Z]$/.test(code ?? '')) return (code as string).slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code ?? '')) return (code as string).slice(5);
  // ⌥Space types a no-break space on a Mac; the key is still Space.
  if (code === 'Space') return 'space';
  const named: Record<string, string> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Escape: 'escape',
    Enter: 'enter',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
    Insert: 'insert',
    Home: 'home',
    End: 'end',
    PageUp: 'pageup',
    PageDown: 'pagedown',
    ' ': 'space',
    Clear: 'clear',
  };
  const mapped = named[key];
  if (mapped) return mapped;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key.toLowerCase();
  return key.length === 1 ? key.toLowerCase() : undefined;
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The combination a keyboard event makes, canonical. `scope: 'pi-kit'` folds ⌘ and Ctrl into `mod`; `'pi'` keeps `ctrl`
 * and calls ⌘ `super`, which is what pi's terminal protocol calls it. `undefined` while only modifiers are down.
 */
export function comboFromEvent(event: KeyEventLike, scope: 'pi' | 'pi-kit'): string | undefined {
  const key = eventKey(event);
  if (!key) return undefined;
  const mods: string[] = [];
  // pi-kit's own shortcuts treat ⌘ and Ctrl alike, as the app always has (a Windows or Linux keyboard has no ⌘, a Mac user may reach for either).
  if (scope === 'pi-kit') {
    if (event.metaKey || event.ctrlKey) mods.push('mod');
  } else {
    if (event.ctrlKey) mods.push('ctrl');
    if (event.metaKey) mods.push('super');
  }
  if (event.altKey) mods.push('alt');
  if (event.shiftKey) mods.push('shift');
  return canonicalCombo([...mods, key].join('+'));
}

/** Does the event make this (pi-kit) combination? */
export function eventMatches(combo: string, event: KeyEventLike): boolean {
  return comboFromEvent(event, 'pi-kit') === canonicalCombo(combo);
}

const MAC_SYMBOLS: Record<string, string> = { mod: '⌘', super: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  enter: '⏎',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  backspace: '⌫',
  delete: 'Del',
  tab: 'Tab',
  space: 'Space',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
  insert: 'Ins',
  clear: 'Clear',
};

/** `⌘⇧M` on a Mac, `Ctrl+Shift+M` elsewhere. */
export function formatCombo(combo: string, mac: boolean): string {
  const canonical = canonicalCombo(combo);
  if (!canonical) return combo;
  const parts = canonical.split('+');
  const key = parts.pop() as string;
  const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase());
  if (mac) return `${parts.map((m) => MAC_SYMBOLS[m] ?? m).join('')}${label}`;
  const names: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Win' };
  return [...parts.map((m) => names[m] ?? m), label].join('+');
}

export interface BindingRef {
  id: string;
  keys: readonly string[];
}

/**
 * Which actions share a key with another action: `id -> [ids it clashes with]`, only for ids that clash. `keys` may be spelled any way;
 * an action listing the same key twice does not clash with itself.
 */
export function findConflicts(bindings: readonly BindingRef[]): Map<string, string[]> {
  const byCombo = new Map<string, Set<string>>();
  for (const binding of bindings) {
    for (const raw of binding.keys) {
      const combo = canonicalCombo(raw);
      if (!combo) continue;
      byCombo.set(combo, (byCombo.get(combo) ?? new Set()).add(binding.id));
    }
  }
  const out = new Map<string, string[]>();
  for (const ids of byCombo.values()) {
    if (ids.size < 2) continue;
    for (const id of ids)
      out.set(id, [...new Set([...(out.get(id) ?? []), ...[...ids].filter((other) => other !== id)])]);
  }
  return out;
}

/** The actions that already use `combo`, other than `except`. */
export function usedBy(bindings: readonly BindingRef[], combo: string, except?: string): string[] {
  const canonical = canonicalCombo(combo);
  if (!canonical) return [];
  return bindings
    .filter((b) => b.id !== except && b.keys.some((k) => canonicalCombo(k) === canonical))
    .map((b) => b.id);
}

/** True for a string that `canonicalCombo` accepts and that pi's documented key syntax allows. */
export function isValidPiKey(text: string): boolean {
  const combo = canonicalCombo(text);
  if (!combo) return false;
  const key = combo.split('+').pop() as string;
  return (
    /^[a-z0-9]$/.test(key) ||
    /^f([1-9]|1[0-2])$/.test(key) ||
    [
      'escape',
      'enter',
      'tab',
      'space',
      'backspace',
      'delete',
      'insert',
      'clear',
      'home',
      'end',
      'pageup',
      'pagedown',
      'up',
      'down',
      'left',
      'right',
    ].includes(key) ||
    /^[`\-=[\]\\;',./!@#$%^&*()_+|~{}:<>?]$/.test(key)
  );
}
