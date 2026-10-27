import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { localExecutable, localCommand } from './local-hardware.service';
import { detectModelMtp, readMtpHeads } from './local-model-mtp';
vi.mock('./local-hardware.service', () => ({ localExecutable: vi.fn(), localCommand: vi.fn() }));
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const text = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
const gguf = (heads?: number) => Buffer.concat([
  Buffer.from('GGUF'), u32(3), u64(0), u64(heads === undefined ? 2 : 3),
  text('general.architecture'), u32(8), text('qwen35'),
  text('tokenizer.ggml.tokens'), u32(9), u32(8), u64(2), text('hello'), text('world'),
  ...(heads === undefined ? [] : [text('qwen35.nextn_predict_layers'), u32(4), u32(heads)]),
]);
const document = (cmd: string) => parseDocument(`models:\n  model:\n    cmd: ${JSON.stringify(cmd)}\n`);
describe('MTP availability', () => {
  let dir: string, model: string;
  beforeEach(async () => {
    vi.clearAllMocks(); dir = await mkdtemp(join(tmpdir(), 'pk-mtp-')); model = join(dir, 'model.gguf');
    vi.mocked(localExecutable).mockResolvedValue(join(dir, 'llama-server'));
    vi.mocked(localCommand).mockResolvedValue('--spec-type none,draft-mtp --spec-draft-n-max N');
  });
  afterEach(async () => { await rm(dir, {recursive:true,force:true}); });
  it('finds MTP heads after unrelated arrays and distinguishes a non-MTP GGUF', async () => {
    await writeFile(model, gguf(1)); expect(await readMtpHeads(model)).toBe(1);
    expect(await detectModelMtp(document(`llama-server -m ${model}`), 'model')).toEqual({status:'detected', heads:1});
    await writeFile(model, gguf()); expect(await readMtpHeads(model)).toBe(0);
    expect(await detectModelMtp(document(`llama-server -m ${model}`), 'model')).toEqual({status:'no-heads', heads:0});
  });
  it('uses a separate draft GGUF and checks actual installed-engine support', async () => {
    await writeFile(model, gguf(2));
    expect(await detectModelMtp(document(`llama-server -m /missing/main.gguf -md ${model}`), 'model')).toEqual({status:'detected',heads:2});
    expect(localCommand).toHaveBeenCalledWith(join(dir,'llama-server'), ['--help'], 3000);
  });
  it('does not run an arbitrary executable from YAML or guess a service working directory', async () => {
    await writeFile(model, gguf(1));
    expect(await detectModelMtp(document(`/untrusted/llama-server -m ${model}`), 'model')).toMatchObject({status:'engine-unverified'});
    expect(await detectModelMtp(document('llama-server -m relative.gguf'), 'model')).toEqual({status:'model-unreadable'});
    expect(localCommand).not.toHaveBeenCalled();
  });
  it('keeps existing MTP setups editable without claiming their weights were verified', async () => {
    expect(await detectModelMtp(document('llama-server --spec-type ngram-mod,draft-mtp -m /missing.gguf'), 'model')).toEqual({status:'configured'});
    expect(localCommand).not.toHaveBeenCalled();
  });
  it('does not infer MTP support from a filename, malformed metadata or unsupported engine', async () => {
    await writeFile(model, Buffer.from('GGUF')); expect(await readMtpHeads(model)).toBeUndefined();
    await writeFile(model, Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(1),u64(Number.MAX_SAFE_INTEGER)]));
    expect(await readMtpHeads(model)).toBeUndefined();
    await writeFile(model, gguf(1)); vi.mocked(localCommand).mockResolvedValue('--ctx-size N');
    expect(await detectModelMtp(document(`llama-server -m ${model}`), 'model')).toMatchObject({status:'engine-unsupported'});
  });
});
