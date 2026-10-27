import { describe, it, expect } from 'vitest';
import { parseDocument } from 'yaml';
import { readModelOptions, patchModelOptions } from './local-model-options';

const document = (cmd: string) => parseDocument(`macros:\n  ctx: 16384\nmodels:\n  qwen:\n    cmd: ${JSON.stringify(cmd)}\n    ttl: 120\n    aliases: [unchanged]\n`);
describe('configured model controls', () => {
  it('reads aliases, equals values, quoted arguments and macros without executing anything', () => {
    const doc = document(`'/opt/a path/llama-server' --model '/models/a b.gguf' -c \${ctx} -ngl=all -fa -np 2 --temp 0.7 --top-p=0.9 --chat-template-kwargs '{"think":false}'`);
    expect(readModelOptions(doc, 'qwen')).toMatchObject({ engine: 'llama.cpp', values: { context: 16384, gpuLayers: 'all', flashAttention: 'on', parallel: 2, temperature: 0.7, topP: 0.9, ttl: 120 } });
    patchModelOptions(doc, 'qwen', { context: 32768, temperature: 0.5, threads: 8, ttl: 0 });
    const after = doc.getIn(['models', 'qwen', 'cmd']) as string;
    expect(after).toContain("--model '/models/a b.gguf'");
    expect(after).toContain(`--chat-template-kwargs '{"think":false}'`);
    expect(after).toContain('-c 32768'); expect(after).toContain('--temp 0.5'); expect(after).toContain('--threads 8');
    expect(doc.getIn(['macros', 'ctx'])).toBe(16384);
    expect(doc.getIn(['models', 'qwen', 'aliases', 0])).toBe('unchanged');
  });
  it('replaces duplicate aliases together and resets a control without leaving an overriding duplicate', () => {
    const doc = document('llama-server -c 2048 --ctx-size=8192 --host 127.0.0.1 --port ${PORT}');
    patchModelOptions(doc, 'qwen', { context: 16384 });
    expect((doc.getIn(['models', 'qwen', 'cmd']) as string).match(/(?:-c |--ctx-size)/g)).toHaveLength(1);
    patchModelOptions(doc, 'qwen', { context: null });
    expect(readModelOptions(doc, 'qwen').values.context).toBeNull();
    expect(doc.getIn(['models', 'qwen', 'cmd'])).toContain('--port ${PORT}');
  });
  it('edits existing options on custom macro launchers without changing shared macros', () => {
    const doc = document('${launcher} -m model.gguf --ctx ${ctx}');
    expect(readModelOptions(doc, 'qwen').supported).toEqual(['name', 'ttl', 'context']);
    patchModelOptions(doc, 'qwen', { context: 8192 });
    expect(doc.getIn(['models', 'qwen', 'cmd'])).toBe('${launcher} -m model.gguf --ctx 8192');
    expect(doc.getIn(['macros', 'ctx'])).toBe(16384);
    expect(() => patchModelOptions(doc, 'qwen', { gpuLayers: 10 })).toThrow('not supported');
  });
  it('keeps arbitrary scripts out of engine controls while exposing idle unloading', () => {
    for (const cmd of ["sh -c 'llama-server -c 1234'", "python -c 'print(1234)'", 'docker run -c 8 engine', 'llama-server -c 1234; other-command', 'llama-server --model $(other-command -c 1234)']) {
      const doc = document(cmd);
      expect(readModelOptions(doc, 'qwen').supported).toEqual(['name', 'ttl']);
      patchModelOptions(doc, 'qwen', { ttl: 0 });
      expect(doc.getIn(['models', 'qwen', 'cmd'])).toBe(cmd);
    }
  });
  it('adds new options after comments but before an end-of-options marker', () => {
    const doc = document('llama-server --model m.gguf # preserve comment');
    patchModelOptions(doc, 'qwen', { context: 4096 });
    expect(doc.getIn(['models', 'qwen', 'cmd'])).toContain('# preserve comment\n--ctx-size 4096');
    const marked = document('llama-server --model m.gguf -- positional');
    patchModelOptions(marked, 'qwen', { context: 4096, threads: 8 });
    expect(marked.getIn(['models', 'qwen', 'cmd'])).toContain('--ctx-size 4096 --threads 8 -- positional');
  });
  it('edits MTP flags and draft paths without losing other speculative modes or unknown arguments', () => {
    const doc = document('llama-server -m /models/main.gguf --spec-type=ngram-mod,draft-mtp --draft-max 4 --spec-draft-n-max 6 --draft-min=1 --draft-p-min 0.2 --model-draft "/models/old draft.gguf" --custom keep');
    expect(readModelOptions(doc, 'qwen').values).toMatchObject({specType: 'ngram-mod,draft-mtp', specDraftMax: 6, specDraftMin: 1, specDraftPMin: 0.2, draftModel: '/models/old draft.gguf'});
    patchModelOptions(doc, 'qwen', {specDraftMax: 8, specDraftMin: 2, draftModel: "/models/a draft's head.gguf"});
    const text = doc.getIn(['models','qwen','cmd']) as string;
    expect(text).toContain('--spec-type=ngram-mod,draft-mtp'); expect(text).toContain('--custom keep');
    expect(text.match(/--(?:draft-max|spec-draft-n-max)/g)).toHaveLength(1);
    expect(readModelOptions(doc, 'qwen').values.draftModel).toBe("/models/a draft's head.gguf");
    expect(() => patchModelOptions(doc, 'qwen', {specDraftMin: 9})).toThrow('Minimum draft tokens');
    patchModelOptions(doc, 'qwen', {specType: null, specDraftMax: null, draftModel: null});
    expect(readModelOptions(doc, 'qwen').values.specType).toBeUndefined();
    expect(doc.getIn(['models','qwen','cmd'])).not.toMatch(/--model-draft|--spec-draft-n-max/);
  });
  it('adds MTP controls only after detection, while allowing selection of a separate draft model', () => {
    const doc = document('llama-server --model /models/plain.gguf');
    expect(readModelOptions(doc, 'qwen').supported).not.toContain('specType');
    expect(readModelOptions(doc, 'qwen').supported).toContain('draftModel');
    expect(() => patchModelOptions(doc, 'qwen', {specType: 'draft-mtp'})).toThrow('not supported');
    patchModelOptions(doc, 'qwen', {specType: 'draft-mtp', specDraftMax: 3}, true);
    expect(readModelOptions(doc, 'qwen').values).toMatchObject({specType:'draft-mtp',specDraftMax:3});
  });
  it('refuses shared YAML anchors instead of changing other models implicitly', () => {
    for (const text of [
      'models: {qwen: &shared {cmd: llama-server}, other: *shared}',
      'models:\n  qwen:\n    cmd: &command llama-server -c 4096\n  other:\n    cmd: *command\n',
      'models:\n  qwen:\n    cmd: llama-server\n    ttl: &idle 60\n  other:\n    ttl: *idle\n',
    ]) {
      const doc = parseDocument(text), before = doc.toString();
      expect(() => patchModelOptions(doc, 'qwen', { ttl: 0 })).toThrow('shared YAML anchors');
      expect(doc.toString()).toBe(before);
    }
  });
});
