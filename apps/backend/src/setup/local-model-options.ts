import { basename } from 'node:path';
import { isMap, isScalar, type Document, type YAMLMap } from 'yaml';
import { LocalModelOptionValuesSchema, type LocalModelOptions, type LocalModelOptionsSave, type LocalModelOptionValues } from '@pi-kit/protocol';

type Key = keyof LocalModelOptionValues;
type Token = { start: number; end: number; value: string };
const flags: Partial<Record<Key, string[]>> = {
  context: ['--ctx-size', '-c', '--ctx'], gpuLayers: ['--gpu-layers', '--n-gpu-layers', '-ngl'],
  threads: ['--threads', '-t'], parallel: ['--parallel', '-np'], flashAttention: ['--flash-attn', '-fa'],
  specType: ['--spec-type'], specDraftMax: ['--spec-draft-n-max', '--draft-max', '--draft'], specDraftMin: ['--spec-draft-n-min', '--draft-min'], specDraftPMin: ['--spec-draft-p-min', '--draft-p-min'], draftModel: ['--spec-draft-model', '--model-draft', '-md'],
  temperature: ['--temp', '--temperature'], topP: ['--top-p'], topK: ['--top-k'], minP: ['--min-p'],
};

/** Token spans let edits preserve every unknown argument and its original quoting. No shell is executed. */
function tokenize(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    const start = i;
    let value = '', quote = '';
    for (; i < text.length; i++) {
      const ch = text[i];
      if (!quote && /\s/.test(ch)) break;
      if (!quote && /[;|&<>`()]/.test(ch)) return undefined;
      if (ch === '\\' && quote !== "'") {
        i++; if (i >= text.length) return undefined;
        if (text[i] !== '\n') value += text[i];
      } else if (ch === quote) quote = '';
      else if (!quote && (ch === "'" || ch === '"')) quote = ch;
      else value += ch;
    }
    if (quote) return undefined;
    tokens.push({ start, end: i, value });
  }
  return tokens;
}

function entry(document: Document, model: string): YAMLMap {
  const value = document.getIn(['models', model], true);
  if (!isMap(value)) throw new Error('This model uses a YAML reference or a nonstandard entry. Use Advanced YAML to edit it.');
  if (value.anchor || ['name', 'ttl', 'cmd'].some((key) => { const node = value.get(key, true); return isScalar(node) && !!node.anchor; })) {
    throw new Error('This model defines shared YAML anchors. Use Advanced YAML to change them without affecting other models.');
  }
  return value;
}

function macroValue(document: Document, model: string, text: string): string {
  let value = text;
  for (let i = 0; i < 8; i++) {
    const next = value.replace(/\$\{([a-zA-Z0-9_-]+)\}/g, (original, name: string) => {
      const found = document.getIn(['models', model, 'macros', name]) ?? document.getIn(['macros', name]);
      return typeof found === 'string' || typeof found === 'number' || typeof found === 'boolean' ? String(found) : original;
    });
    if (next === value || next.length > 32_000) break;
    value = next;
  }
  return value;
}

function occurrences(tokens: Token[], names: string[]): { flag: string; start: number; end: number; raw: string }[] {
  const found: { flag: string; start: number; end: number; raw: string }[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value === '--') break;
    const equal = token.value.indexOf('='), flag = equal < 0 ? token.value : token.value.slice(0, equal);
    if (!names.includes(flag)) continue;
    if (equal >= 0) found.push({ flag, start: token.start, end: token.end, raw: token.value.slice(equal + 1) });
    else {
      const next = tokens[i + 1];
      // Bare Flash Attention flags mean enabled; another option must never be consumed as its value.
      if (flag === '-fa' || flag === '--flash-attn') {
        const hasValue = next && /^(on|off|auto|0|1|true|false)$/.test(next.value);
        found.push({ flag, start: token.start, end: hasValue ? next.end : token.end, raw: hasValue ? next.value : 'on' });
        if (hasValue) i++;
      } else {
        if (!next || (/^-/.test(next.value) && !/^-\d/.test(next.value))) throw new Error('A model argument is missing its value. Correct it in Advanced YAML.');
        found.push({ flag, start: token.start, end: next.end, raw: next.value }); i++;
      }
    }
  }
  return found;
}

export function readModelOptions(document: Document, model: string, allowSpeculative = false): Omit<LocalModelOptions, 'path' | 'model' | 'version'> {
  const config = entry(document, model), command = config.get('cmd');
  let tokens = typeof command === 'string' && command.length <= 256_000 ? tokenize(command) : undefined;
  if (tokens?.[0] && /^(?:sh|bash|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|env)$/.test(basename(tokens[0].value))) tokens = undefined;
  const expanded = tokens?.[0] ? (tokens[0].value.includes('${') ? tokenize(macroValue(document, model, tokens[0].value)) : [tokens[0]]) : undefined;
  const executable = expanded?.[0]?.value;
  const llama = !!executable && /^llama-server(?:[.-][\w.-]+)?$/.test(basename(executable));
  const values: Partial<LocalModelOptionValues> = {}, inherited: Record<string, string> = {};
  const supported: Key[] = ['name', 'ttl'];
  for (const key of supported) {
    const raw = config.get(key);
    if (raw === undefined) values[key] = null;
    else {
      const decoded = LocalModelOptionValuesSchema.shape[key].safeParse(raw);
      if (decoded.success) Object.assign(values, { [key]: decoded.data });
      else { inherited[key] = 'Custom YAML value. Leave unchanged to preserve it.'; }
    }
  }
  const configuredMtp = tokens && occurrences(tokens, ['--spec-type']).some((match) => macroValue(document, model, match.raw).split(',').includes('draft-mtp'));
  if (tokens) for (const [key, aliases] of Object.entries(flags) as [Key, string[]][]) {
    // Short options on an unknown launcher may mean something else (python -c, docker -c).
    const names = llama ? aliases : aliases.filter((name) => name.startsWith('--'));
    const matches = occurrences(tokens, names);
    if (!llama && !matches.length) continue;
    if (key.startsWith('spec') && !matches.length && !(llama && (allowSpeculative || configuredMtp))) continue;
    supported.push(key);
    const raw = matches.at(-1)?.raw;
    if (raw === undefined) { Object.assign(values, { [key]: null }); continue; }
    let resolved = macroValue(document, model, raw);
    if (key === 'flashAttention') resolved = /^(1|true)$/.test(resolved) ? 'on' : /^(0|false)$/.test(resolved) ? 'off' : resolved;
    const candidate = key === 'specType' || key === 'draftModel' || key === 'flashAttention' || (key === 'gpuLayers' && /^(auto|all)$/.test(resolved)) ? resolved : /^-?\d+(?:\.\d+)?$/.test(resolved) ? Number(resolved) : undefined;
    const decoded = LocalModelOptionValuesSchema.shape[key].safeParse(candidate);
    if (decoded.success) Object.assign(values, { [key]: decoded.data });
    if (raw.includes('${')) inherited[key] = 'Uses a config macro. Changing this field overrides it for this model only.';
    else if (!decoded.success) inherited[key] = 'Custom argument value. Leave unchanged to preserve it.';
  }
  return { engine: llama ? 'llama.cpp' : 'custom', values, supported, inherited };
}

export function patchModelOptions(document: Document, model: string, values: LocalModelOptionsSave['values'], allowSpeculative = false): void {
  const config = entry(document, model), current = readModelOptions(document, model, allowSpeculative);
  const min = values.specDraftMin === undefined ? current.values.specDraftMin : values.specDraftMin;
  const max = values.specDraftMax === undefined ? current.values.specDraftMax : values.specDraftMax;
  if (typeof min === 'number' && typeof max === 'number' && min > max) throw new Error('Minimum draft tokens must not exceed maximum draft tokens.');
  const command = config.get('cmd'), tokens = typeof command === 'string' ? tokenize(command) : undefined;
  const replacements: { start: number; end: number; text: string }[] = [], append: string[] = [];
  for (const [key, value] of Object.entries(values) as [Key, LocalModelOptionValues[Key]][]) {
    if (!current.supported.includes(key)) throw new Error('This option is not supported by this launcher. Use Advanced YAML.');
    if (key === 'name' || key === 'ttl') {
      if (value === null || value === '') config.delete(key);
      else config.set(key, value);
      continue;
    }
    if (!tokens || typeof command !== 'string') throw new Error('This launcher needs Advanced YAML for command changes.');
    const names = flags[key]?.filter((name) => current.engine === 'llama.cpp' || name.startsWith('--'));
    if (!names) continue;
    const matches = occurrences(tokens, names);
    const flag = matches.at(-1)?.flag ?? names[0];
    for (const match of matches) replacements.push({ start: match.start, end: match.end, text: '' });
    if (value !== null) {
      const rendered = key === 'draftModel' ? `'${String(value).replace(/'/g, `'\\''`)}'` : value;
      const replacement = `${flag} ${rendered}`;
      const last = matches.at(-1);
      if (last) replacements[replacements.length - 1].text = replacement;
      else append.push(replacement);
    }
  }
  if (typeof command === 'string' && (replacements.length || append.length)) {
    let next = command;
    for (const change of replacements.sort((a, b) => b.start - a.start)) next = next.slice(0, change.start) + change.text + next.slice(change.end);
    // Insert before a trailing comment or end-of-options marker so new flags remain effective.
    const marker = tokens?.find((token) => token.value === '--');
    const insertion = marker ? replacements.reduce((offset, change) => offset + (change.start < marker.start ? change.text.length - (change.end - change.start) : 0), marker.start) : undefined;
    if (append.length && insertion !== undefined) next = next.slice(0, insertion) + append.join(' ') + ' ' + next.slice(insertion);
    else if (append.length) next = next.trimEnd() + '\n' + append.join(' ');
    config.set('cmd', next);
  }
}

/** Static command inspection only; never execute a launcher from a user config. */
export function modelCommandInfo(document: Document, model: string): { executable?: string; modelPath?: string; draftPath?: string; configuredMtp: boolean } {
  const cmd = entry(document, model).get('cmd');
  const tokens = typeof cmd === 'string' ? tokenize(cmd) : undefined;
  if (!tokens?.length) return { configuredMtp: false };
  const get = (names: string[]) => { const raw = occurrences(tokens, names).at(-1)?.raw; return raw === undefined ? undefined : macroValue(document, model, raw); };
  return { executable: macroValue(document, model, tokens[0].value), modelPath: get(['--model', '-m']), draftPath: get(['--spec-draft-model', '--model-draft', '-md']), configuredMtp: get(['--spec-type'])?.split(',').includes('draft-mtp') ?? false };
}
