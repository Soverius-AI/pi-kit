import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { Document } from 'yaml';
import type { LocalModelOptions } from '@pi-kit/protocol';
import { localCommand, localExecutable } from './local-hardware.service';
import { modelCommandInfo } from './local-model-options';

const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
class IncompleteHeader extends Error {}
/** Inspects bounded GGUF metadata without loading the model. Truncated/oversized headers stay unknown. */
function metadataHeads(bytes: Buffer): number {
  let at = 0;
  const take = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || at + length > bytes.length) throw new IncompleteHeader();
    const value = bytes.subarray(at, at + length); at += length; return value;
  };
  const u32 = () => take(4).readUInt32LE();
  const u64 = () => { const value = Number(take(8).readBigUInt64LE()); if (!Number.isSafeInteger(value)) throw new Error('Invalid GGUF length'); return value; };
  const text = () => { const length = u64(); if (length > 4096) throw new Error('Invalid GGUF key'); return take(length).toString('utf8'); };
  const skip = (type: number) => {
    if (type === 8) { take(u64()); return; }
    if (type === 9) {
      const element = u32(), count = u64();
      if (count > 2_000_000) throw new Error('GGUF array exceeds inspection limit');
      if (element === 8) { for (let i = 0; i < count; i++) take(u64()); return; }
      if (!sizes[element]) throw new Error('Invalid GGUF array');
      take(count * sizes[element]); return;
    }
    if (!sizes[type]) throw new Error('Invalid GGUF value');
    take(sizes[type]);
  };
  if (take(4).toString('ascii') !== 'GGUF' || ![2, 3].includes(u32())) throw new Error('Unsupported GGUF');
  u64(); const count = u64();
  if (count > 100_000) throw new Error('GGUF metadata exceeds inspection limit');
  for (let i = 0; i < count; i++) {
    const key = text(), type = u32();
    if (key.endsWith('.nextn_predict_layers')) {
      const size = sizes[type];
      if (![0, 2, 4, 10].includes(type) || !size) throw new Error('Invalid MTP metadata');
      const value = take(size);
      const heads = size === 8 ? Number(value.readBigUInt64LE()) : size === 4 ? value.readUInt32LE() : size === 2 ? value.readUInt16LE() : value.readUInt8();
      if (!Number.isSafeInteger(heads) || heads > 4096) throw new Error('Invalid MTP head count');
      return heads;
    }
    skip(type);
  }
  return 0;
}
export async function readMtpHeads(path: string): Promise<number | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return undefined;
    for (const limit of [1024 ** 2, 8 * 1024 ** 2, 32 * 1024 ** 2]) {
      const length = Math.min(stat.size, limit), bytes = Buffer.alloc(length);
      let received = 0;
      while (received < length) {
        const { bytesRead } = await file.read(bytes, received, length - received, received);
        if (!bytesRead) break;
        received += bytesRead;
      }
      try { return metadataHeads(bytes.subarray(0, received)); }
      catch (error) { if (!(error instanceof IncompleteHeader) || length === stat.size) return undefined; }
    }
    return undefined;
  } finally { await file.close(); }
}
let cachedHelp: { path: string; at: number; result: Promise<string> } | undefined;
export async function detectModelMtp(document: Document, model: string): Promise<NonNullable<LocalModelOptions['mtp']>> {
  const command = modelCommandInfo(document, model);
  if (command.configuredMtp) return { status: 'configured' };
  // Relative paths depend on the existing service's working directory; never guess it.
  const path = command.draftPath || command.modelPath;
  if (!path || !isAbsolute(path)) return { status: 'model-unreadable' };
  const heads = await readMtpHeads(path);
  if (heads === undefined) return { status: 'model-unreadable' };
  if (!heads) return { status: 'no-heads', heads: 0 };
  const installed = await localExecutable('llama-server');
  const executable = command.executable;
  if (!installed || !executable) return { status: 'engine-unverified', heads };
  if (isAbsolute(executable)) {
    if (await realpath(executable).catch(() => executable) !== await realpath(installed).catch(() => installed)) return { status: 'engine-unverified', heads };
  } else if (basename(executable) !== 'llama-server' && basename(executable) !== 'llama-server.exe') return { status: 'engine-unverified', heads };
  if (!cachedHelp || cachedHelp.path !== installed || Date.now() - cachedHelp.at > 60_000) cachedHelp = { path: installed, at: Date.now(), result: localCommand(installed, ['--help'], 3000).catch(() => '') };
  const help = await cachedHelp.result;
  if (!help) return { status: 'engine-unverified', heads };
  if (!help.includes('draft-mtp') || !help.includes('--spec-draft-n-max')) return { status: 'engine-unsupported', heads };
  return { status: 'detected', heads };
}
