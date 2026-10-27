import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KeybindingInfo } from '@pi-kit/protocol';

/**
 * pi’s application key bindings (docs/keybindings.md of pi 1.3.0) for the keybinding editor of Settings. The SDK declares
 * `KeybindingsManager` as a type only, so its table is copied here, like the built-in command table; pi’s editor, cursor and
 * list bindings (`tui.*`) are left out because they only mean something inside the terminal widget. A user’s `<agentDir>/keybindings.json`
 * replaces the default of an action, as it does in the CLI. Writing keeps every key of the file this table does not know (`$schema`, `tui.*`).
 */
const DEFAULTS: readonly { id: string; keys: string[]; description: string }[] = [
  { id: 'app.interrupt', keys: ['escape'], description: 'Cancel or abort' },
  { id: 'app.clear', keys: ['ctrl+c'], description: 'Clear editor, then exit' },
  { id: 'app.exit', keys: ['ctrl+d'], description: 'Exit when editor is empty' },
  { id: 'app.suspend', keys: ['ctrl+z'], description: 'Suspend to background' },
  { id: 'app.editor.external', keys: ['ctrl+g'], description: 'Open external editor' },
  { id: 'app.clipboard.pasteImage', keys: ['ctrl+v'], description: 'Paste files, images, or text from clipboard' },
  { id: 'app.thinking.cycle', keys: ['shift+tab'], description: 'Cycle thinking level' },
  { id: 'app.thinking.save', keys: ['ctrl+s'], description: 'Save thinking level to settings' },
  { id: 'app.thinking.toggle', keys: ['ctrl+t'], description: 'Collapse or expand thinking blocks' },
  { id: 'app.model.cycleForward', keys: ['ctrl+p'], description: 'Cycle to next model' },
  { id: 'app.model.cycleBackward', keys: ['shift+ctrl+p'], description: 'Cycle to previous model' },
  { id: 'app.model.select', keys: ['ctrl+l'], description: 'Open model selector' },
  { id: 'app.tools.expand', keys: ['ctrl+o'], description: 'Collapse or expand tool output' },
  { id: 'app.message.copy', keys: ['ctrl+x'], description: 'Copy selection or last assistant message' },
  { id: 'app.message.followUp', keys: ['alt+enter'], description: 'Queue follow-up message' },
  { id: 'app.message.dequeue', keys: ['alt+up'], description: 'Restore queued messages' },
  { id: 'app.session.new', keys: [], description: 'Start a new session' },
  { id: 'app.session.tree', keys: [], description: 'Open session tree' },
  { id: 'app.session.fork', keys: [], description: 'Fork current session' },
  { id: 'app.session.resume', keys: [], description: 'Resume a session' },
];

export const PI_KEYBINDING_IDS: ReadonlySet<string> = new Set(DEFAULTS.map((d) => d.id));

const fileOf = (agentDir: string): string => join(agentDir, 'keybindings.json');

function readUser(agentDir: string): Record<string, unknown> {
  const file = fileOf(agentDir);
  try {
    if (!existsSync(file)) return {};
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A file pi would refuse to read is shown as if it were not there; the CLI reports it.
    return {};
  }
}

const keysOf = (value: unknown): string[] | undefined => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : undefined);
const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

export function piKeybindings(agentDir: string): KeybindingInfo[] {
  const user = readUser(agentDir);
  return DEFAULTS.map(({ id, keys, description }) => {
    const override = keysOf(user[id]);
    return { id, keys: override ?? keys, description, default: keys, custom: override !== undefined && !sameKeys(override, keys) };
  });
}

/**
 * Saves the customised keys. `overrides` is the whole set: an action in it gets those keys (an empty list switches the action off, as pi
 * documents), an action not in it goes back to pi’s default. Keys of the file this table does not know are kept. Returns the new table.
 */
export function savePiKeybindings(agentDir: string, overrides: Record<string, string[]>): KeybindingInfo[] {
  const unknown = Object.keys(overrides).filter((id) => !PI_KEYBINDING_IDS.has(id));
  if (unknown.length > 0) throw new Error(`pi has no action called ${unknown.join(', ')}.`);
  const next: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(readUser(agentDir))) if (!PI_KEYBINDING_IDS.has(id)) next[id] = value;
  for (const { id, keys } of DEFAULTS) {
    const wanted = overrides[id];
    if (wanted === undefined || sameKeys(wanted, keys)) continue;
    next[id] = wanted.length === 1 ? wanted[0] : wanted;
  }
  const file = fileOf(agentDir);
  if (Object.keys(next).length === 0 && !existsSync(file)) return piKeybindings(agentDir);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, file);
  return piKeybindings(agentDir);
}
