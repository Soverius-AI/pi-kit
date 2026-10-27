import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseDocument } from 'yaml';

const limit = 2_000_000;

/** Bounded YAML reads never execute commands or expand engine macros. */
export async function readLlamaSwapText(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Choose a regular llama-swap YAML file.');
    if (info.size > limit) throw new Error('The llama-swap config exceeds 2 MB.');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('The llama-swap config exceeds 2 MB.');
    const text = bytes.subarray(0, length).toString('utf8');
    return { text, info };
  } finally { await file.close(); }
}

export async function readLlamaSwapDocument(path: string) {
  const { text, info } = await readLlamaSwapText(path);
  const document = parseDocument(text);
  let value: unknown;
  try {
    if (document.errors.length) throw new Error('Invalid YAML');
    value = document.toJS({ maxAliasCount: 100 });
  } catch { throw new Error('The llama-swap config contains invalid YAML.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The llama-swap config must be a YAML object.');
  const models: unknown = (value as Record<string, unknown>)['models'];
  if (models !== undefined && (!models || typeof models !== 'object' || Array.isArray(models))) throw new Error('The llama-swap models entry must be a YAML object.');
  return { document, text, info, models: Object.keys(models ?? {}) };
}

export async function readLlamaSwapModels(path: string): Promise<string[]> {
  return (await readLlamaSwapDocument(path)).models;
}
