import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { MetaRepository } from '../db/meta.repository';
import { LocalLlamaSwapService } from './local-llama-swap.service';

vi.mock('./local-llama-swap-discovery', () => ({ discoverLlamaSwapConfigs: async () => [] }));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('reads canonical model file paths for library merging without running custom commands or changing YAML', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-local-library-'))); dirs.push(dir);
  const file = join(dir, 'file with spaces.gguf'), alias = join(dir, 'link.gguf'), config = join(dir, 'config.yaml');
  writeFileSync(file, 'GGUF'); symlinkSync(file, alias);
  const text = `macros:\n  file: ${JSON.stringify(alias)}\nmodels:\n  downloaded:\n    cmd: llama-server --model "\${file}"\n  custom:\n    cmd: echo ignored; llama-server --model /unknown.gguf\n  remote:\n    proxy: http://localhost:9090\n`;
  writeFileSync(config, text); vi.stubEnv('PI_KIT_LLAMA_SWAP_CONFIG', config);
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'empty'));
  const service = new LocalLlamaSwapService({ getSetting: () => undefined, setSetting: () => undefined } as unknown as MetaRepository);
  const entry = (await service.readConfigs()).find((entry) => entry.path === config);
  expect(entry).toMatchObject({ models: ['downloaded', 'custom', 'remote'], modelFiles: { downloaded: file } });
  expect(Object.keys(entry?.modelFiles ?? {})).toEqual(['downloaded']);
  expect(readFileSync(config, 'utf8')).toBe(text);
});
