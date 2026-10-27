import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalHardware } from '@pi-kit/protocol';
import { GIB, type LocalHardwareService } from './local-hardware.service';
import { estimateLocalModel, LocalModelCatalogService } from './local-model-catalog.service';

afterEach(() => vi.unstubAllGlobals());

describe('guided local-model catalogue', () => {
  it('pins downloadable files to the catalogue revision and digest and excludes split models/projectors', async () => {
    const sha = 'a'.repeat(40), digest = 'b'.repeat(64);
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/models') return Response.json(url.searchParams.get('author') === 'Qwen' ? [{ id: 'Qwen/Fixture-GGUF', downloads: 42 }] : []);
      expect(url.pathname).toBe('/api/models/Qwen/Fixture-GGUF');
      return Response.json({ sha, cardData: { license: 'apache-2.0' }, siblings: [
        { rfilename: 'folder/model-Q4_K_M.gguf', lfs: { size: 4 * GIB, sha256: digest } },
        { rfilename: 'model-Q4_K_M-00001-of-00002.gguf', lfs: { size: 4 * GIB, sha256: digest } },
        { rfilename: 'mmproj-Q8_0.gguf', lfs: { size: GIB, sha256: digest } },
        { rfilename: 'model-Q5_K_M.gguf', lfs: { size: GIB, sha256: 'unverified' } },
      ] });
    }));
    const hardware = { detect: async () => ({ ramBytes: 16 * GIB, diskFreeBytes: 20 * GIB }) } as LocalHardwareService;
    const service = new LocalModelCatalogService(hardware);
    const catalog = await service.search('Fixture', 8192);
    expect(catalog.models).toHaveLength(1);
    const candidate = catalog.models[0];
    expect(candidate).toMatchObject({ repository: 'Qwen/Fixture-GGUF', revision: sha, sha256: digest, bytes: 4 * GIB, license: 'apache-2.0', estimate: { fitsMemory: true, fitsDisk: true } });
    expect(service.downloadUrl(service.selection(candidate.id))).toBe(`https://huggingface.co/Qwen/Fixture-GGUF/resolve/${sha}/folder/model-Q4_K_M.gguf`);
    expect(() => service.selection('https://untrusted.invalid/model.gguf')).toThrow(/expired/);
  });

  it('reserves memory for the runtime/context and disk space for the complete download', () => {
    const hardware = { ramBytes: 16 * GIB, diskFreeBytes: 2 * GIB } as LocalHardware;
    expect(estimateLocalModel(8 * GIB, hardware, 8192)).toMatchObject({ fitsMemory: false, fitsDisk: false });
    expect(estimateLocalModel(GIB / 2, hardware, 8192)).toMatchObject({ fitsMemory: true, fitsDisk: true });
    expect(estimateLocalModel(5 * GIB, { ...hardware, diskFreeBytes: 20 * GIB }, 32768).fitsMemory).toBe(false);
  });
});
