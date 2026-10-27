import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, lstat, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { InstalledLocalModel, LocalModelCandidate, LocalStorage, LocalStorageChange } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { GIB, LocalHardwareService } from './local-hardware.service';
import { LocalModelCatalogService } from './local-model-catalog.service';

/** Hashes streamed bytes without loading a model into memory. */
async function digestFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

/** The partial files of a failed or cancelled download could not be removed; a cancelled job still reports it. */
export class LocalDownloadCleanupError extends Error {}

const ownedArtifact = (file: string): 'partial' | 'corrupt' | undefined =>
  /\.gguf\.[a-f0-9-]{36}\.(?:part(?:\.json)?|json\.part)$/.test(file) ? 'partial' : /\.gguf\.corrupt-\d+$/.test(file) ? 'corrupt' : undefined;

/** Atomic, cancellable GGUF downloads. Failed attempts never publish an incomplete model. */
@Injectable()
export class LocalModelFilesService {
  constructor(
    private readonly hardware: LocalHardwareService,
    private readonly catalog: LocalModelCatalogService,
    @Inject(CONFIG) private readonly config: Pick<BackendConfig, 'localRuntime'>,
  ) {}

  async storage(): Promise<LocalStorage> {
    const directory = this.hardware.modelsDirectory();
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const files: LocalStorage['files'] = [];
    for (const file of names.slice(0, 2000)) {
      const kind = ownedArtifact(file);
      if (!kind) continue;
      const path = join(directory, file), info = await lstat(path).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      files.push({ id: createHash('sha256').update(path).digest('hex'), file, bytes: info.size, kind });
    }
    return { directory, freeBytes: await this.hardware.diskFree(), files };
  }

  async removeFile(id: string): Promise<LocalStorageChange> {
    const storage = await this.storage(), file = storage.files.find((entry) => entry.id === id);
    if (!file) throw new BadRequestException('This incomplete or corrupt file is no longer present. Refresh the library.');
    const path = join(storage.directory, file.file);
    // Inventory identifiers never become user-supplied paths; unlink only the single owned entry.
    await rm(path, { force: true });
    return { removedBytes: file.bytes, storage: await this.storage() };
  }

  async cleanup(): Promise<LocalStorageChange> {
    const storage = await this.storage();
    let removedBytes = 0;
    for (const file of storage.files.filter((entry) => entry.kind === 'partial')) {
      await rm(join(storage.directory, file.file), { force: true });
      removedBytes += file.bytes;
    }
    return { removedBytes, storage: await this.storage() };
  }

  async removeModel(id: string): Promise<LocalStorageChange> {
    const model = await this.hardware.model(id);
    // model() resolves a previously discovered ID, never a path supplied to this endpoint.
    await rm(model.path);
    const managed = await realpath(this.hardware.modelsDirectory()).catch(() => undefined);
    if (managed && dirname(model.path) === managed) await rm(`${model.path}.json`, { force: true });
    this.hardware.forget(id);
    return { removedBytes: model.bytes, storage: await this.storage() };
  }

  private async cleanupPartial(paths: string[]): Promise<void> {
    try { for (const path of paths) await rm(path, { force: true }); }
    catch (error) { throw new LocalDownloadCleanupError('The incomplete file could not be removed. Use storage cleanup to free its space.', { cause: error }); }
  }

  async verifiedModel(id: string, signal: AbortSignal): Promise<InstalledLocalModel> {
    const model = await this.hardware.model(id);
    if (model.sha256 && await digestFile(model.path, signal) !== model.sha256) throw new Error('The downloaded model checksum no longer matches. Download it again before starting.');
    signal.throwIfAborted();
    return model;
  }

  async download(model: LocalModelCandidate, signal: AbortSignal, progress: (receivedBytes: number, totalBytes: number) => void): Promise<InstalledLocalModel> {
    const dir = this.hardware.modelsDirectory();
    const name = `${model.repository.replace('/', '--')}--${basename(model.file)}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160).replace(/\.gguf$/i, '');
    const target = join(dir, `${name}-${model.id.slice(0, 12)}.gguf`);
    await mkdir(dir, { recursive: true });
    // A hard process exit cannot run finally. The single-job owner makes these prior-attempt files safe to remove on retry.
    const prefix = `${basename(target)}.`;
    for (const file of await readdir(dir)) {
      if (file.startsWith(prefix) && /^[a-f0-9-]{36}\.(?:part(?:\.json)?|json\.part)$/.test(file.slice(prefix.length))) await rm(join(dir, file), { force: true });
    }
    const existing = await stat(target).catch(() => undefined);
    if (existing?.size === model.bytes && await digestFile(target, signal) === model.sha256) {
      const metadata = `${target}.${randomUUID()}.json.part`;
      try {
        await writeFile(metadata, JSON.stringify({ source: model.source, sha256: model.sha256, file: basename(model.file) }), { mode: 0o600 });
        await rename(metadata, `${target}.json`);
      } finally { await rm(metadata, { force: true }); }
      const held = await this.hardware.describe(target);
      if (held) { this.hardware.remember(held); progress(model.bytes, model.bytes); return held; }
    }
    if (await this.hardware.diskFree() < model.bytes + GIB) throw new Error('Not enough free disk space for this model plus a 1 GiB reserve. Choose a smaller file or free space, then retry.');
    const partial = `${target}.${randomUUID()}.part`;
    const metadataPartial = `${partial}.json`;
    const abort = AbortSignal.any([signal, AbortSignal.timeout(this.config.localRuntime?.downloadMs ?? 2 * 60 * 60_000)]);
    let received = 0;
    const hash = createHash('sha256');
    try {
      const response = await fetch(this.catalog.downloadUrl(model), { signal: abort });
      if (!response.ok || !response.body) throw new Error(`The model download returned ${response.status}. Search again or retry.`);
      const total = Number(response.headers.get('content-length'));
      if (total && total !== model.bytes) {
        await response.body.cancel();
        throw new Error('The server file size differs from the pinned catalogue entry. Search again before downloading.');
      }
      const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > model.bytes) { done(new Error('The model download exceeded its pinned size.')); return; }
        hash.update(chunk);
        progress(received, model.bytes);
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: abort });
      if (received !== model.bytes || hash.digest('hex') !== model.sha256) throw new Error('The model size or SHA-256 checksum did not match. The partial download was removed; retry or select another file.');
      const file = await open(partial, 'r');
      try {
        const magic = Buffer.alloc(4);
        await file.read(magic, 0, 4, 0);
        if (magic.toString('ascii') !== 'GGUF') throw new Error('The downloaded file is not a GGUF model.');
      } finally { await file.close(); }
      await writeFile(metadataPartial, JSON.stringify({ source: model.source, sha256: model.sha256, file: basename(model.file) }), { mode: 0o600 });
      abort.throwIfAborted();
      if (existing) await rename(target, `${target}.corrupt-${Date.now()}`);
      await rename(partial, target);
      await rename(metadataPartial, `${target}.json`);
      const ready = await this.hardware.describe(target);
      if (!ready) throw new Error('The downloaded model could not be opened. Detect again before starting.');
      this.hardware.remember(ready);
      progress(model.bytes, model.bytes);
      return ready;
    } finally {
      await this.cleanupPartial([partial, metadataPartial]);
    }
  }
}
