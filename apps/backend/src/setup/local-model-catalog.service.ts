import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { LocalCatalog, LocalHardware, LocalModelCandidate } from '@pi-kit/protocol';
import { z } from 'zod';
import { GIB, LocalHardwareService } from './local-hardware.service';
import { boundedJson } from './http-body';

const PUBLISHERS = ['ggml-org', 'Qwen', 'unsloth', 'bartowski'] as const;
const ListingSchema = z.array(z.object({ id: z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/), downloads: z.number().optional() })).max(100);
const RepositorySchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/), private: z.boolean().optional(), gated: z.union([z.boolean(), z.string()]).optional(),
  cardData: z.object({ license: z.union([z.string(), z.array(z.string())]).optional() }).passthrough().optional(),
  siblings: z.array(z.object({ rfilename: z.string().max(500), size: z.number().optional(), lfs: z.object({ sha256: z.string(), size: z.number() }).optional() })).max(2000),
});

/** Conservative planning allowance, not a claim about real KV-cache use or tokens/second. */
export function estimateLocalModel(bytes: number, hardware: Pick<LocalHardware, 'ramBytes' | 'diskFreeBytes'>, contextTokens: number): LocalModelCandidate['estimate'] {
  const memoryBytes = Math.ceil(bytes * 1.15 + 2 * GIB + contextTokens * 256 * 1024);
  return {
    contextTokens, memoryBytes,
    fitsMemory: memoryBytes <= hardware.ramBytes * 0.65,
    fitsDisk: bytes + GIB <= hardware.diskFreeBytes,
    explanation: 'Rough weights + runtime/context allowance, reserving 35% of RAM for the OS and other apps. KV-cache use, architecture and GPU offload vary. Speed and capabilities require a local test.',
  };
}

async function hubJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
  if (!response.ok || !response.body) throw new Error(`Hugging Face returned ${response.status}. Try again, or reuse an existing model.`);
  return boundedJson(response, 2_000_000);
}

const quantRank = (file: string): number => /Q4_K_M/i.test(file) ? 0 : /Q5_K_M/i.test(file) ? 1 : /Q4_0/i.test(file) ? 2 : /Q6_K/i.test(file) ? 3 : /Q8_0/i.test(file) ? 4 : 5;

/** Catalogue entries pin repository revision, size and SHA; callers cannot supply an arbitrary download URL. */
@Injectable()
export class LocalModelCatalogService {
  private readonly selections = new Map<string, LocalModelCandidate>();
  constructor(private readonly hardware: LocalHardwareService) {}

  async search(query = '', contextTokens = 8192): Promise<LocalCatalog> {
    const facts = await this.hardware.detect();
    const listings = await Promise.allSettled(PUBLISHERS.map(async (author) => {
      const params = new URLSearchParams({ author, filter: 'gguf', pipeline_tag: 'text-generation', sort: 'trendingScore', direction: '-1', limit: '3', ...(query.trim() ? { search: query.trim() } : {}) });
      return ListingSchema.parse(await hubJson(`https://huggingface.co/api/models?${params}`));
    }));
    const repositories = listings.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    const notes: string[] = [];
    if (listings.some((result) => result.status === 'rejected')) notes.push('Some publishers could not be reached. The list may be incomplete.');
    const groups = await Promise.allSettled(repositories.map(async ({ id, downloads }) => {
      if (!PUBLISHERS.some((author) => id.startsWith(`${author}/`))) return [];
      const repo = RepositorySchema.parse(await hubJson(`https://huggingface.co/api/models/${id}?blobs=true`));
      if (repo.private || repo.gated) return [];
      const files = repo.siblings.filter((file) => /\.gguf$/i.test(file.rfilename) && /(?:Q[4-8]_|IQ4_)/i.test(file.rfilename) && !/mmproj|-\d{5}-of-\d{5}/i.test(file.rfilename) && file.lfs?.sha256.match(/^[a-f0-9]{64}$/) && file.lfs.size > 8 && file.rfilename.split('/').every((part) => part && part !== '.' && part !== '..'));
      files.sort((a, b) => quantRank(a.rfilename) - quantRank(b.rfilename));
      return files.slice(0, 2).map((file): LocalModelCandidate => {
        const bytes = file.lfs?.size ?? 0;
        const candidate: LocalModelCandidate = {
          id: createHash('sha256').update(`${id}/${repo.sha}/${file.rfilename}`).digest('hex'),
          repository: id, revision: repo.sha, file: file.rfilename, bytes, sha256: file.lfs?.sha256 ?? '',
          license: Array.isArray(repo.cardData?.license) ? repo.cardData.license.join(', ') : repo.cardData?.license ?? 'See the model card',
          source: `https://huggingface.co/${id}`, downloads: downloads ?? 0,
          estimate: estimateLocalModel(bytes, facts, contextTokens),
        };
        this.selections.delete(candidate.id);
        this.selections.set(candidate.id, candidate);
        while (this.selections.size > 200) {
          const oldest = this.selections.keys().next().value;
          if (!oldest) break;
          this.selections.delete(oldest);
        }
        return candidate;
      });
    }));
    if (groups.some((result) => result.status === 'rejected')) notes.push('Some model cards could not be read. Search again to retry.');
    const models = groups.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    models.sort((a, b) => Number(b.estimate.fitsMemory && b.estimate.fitsDisk) - Number(a.estimate.fitsMemory && a.estimate.fitsDisk) || b.downloads - a.downloads || a.bytes - b.bytes);
    notes.push('Public single-file language GGUFs from the listed publishers. Split models, gated downloads and separate vision projectors need manual setup. Tool calling and image support are not inferred from a model name.');
    return { models, notes };
  }

  selection(id: string): LocalModelCandidate {
    const model = this.selections.get(id);
    if (!model) throw new Error('This catalogue selection expired. Search again before downloading.');
    return model;
  }

  downloadUrl(model: LocalModelCandidate): string {
    return `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.file.split('/').map(encodeURIComponent).join('/')}`;
  }
}
