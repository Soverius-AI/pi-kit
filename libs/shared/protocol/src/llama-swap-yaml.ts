import { parseDocument } from 'yaml';

/** Checks syntax and the model mapping without exposing commands in diagnostic messages. */
export function checkLlamaSwapYaml(text: string): { code: 'size' | 'syntax' | 'aliases' | 'object' | 'models'; line?: number; message: string } | undefined {
  if (new TextEncoder().encode(text).length > 2_000_000) return { code: 'size', message: 'The llama-swap config exceeds 2 MB.' };
  const document = parseDocument(text);
  const error = document.errors[0];
  if (error) return { code: 'syntax', line: text.slice(0, error.pos[0]).split('\n').length, message: 'Invalid YAML. Check indentation, quotes and brackets.' };
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 100 }); }
  catch { return { code: 'aliases', message: 'The YAML contains too many aliases.' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { code: 'object', line: 1, message: 'The llama-swap config must be a YAML object.' };
  const models = (value as Record<string, unknown>)['models'];
  if (models !== undefined && (!models || typeof models !== 'object' || Array.isArray(models))) return { code: 'models', message: 'The models entry must be a YAML object.' };
  return undefined;
}
