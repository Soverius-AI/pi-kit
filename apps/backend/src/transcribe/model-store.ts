import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { TranscribeModel } from '@pi-kit/protocol';

/**
 * The Whistle model file in pi-kit's data folder. It is never bundled and never fetched on its own: `download()` runs
 * only when the user clicked "Download Whistle" in Settings (the controller refuses a request without `accept: true`). The file is pinned by
 * size and SHA-256 (the revision and hash that `cactus-needle` 0.3.0 pins for the same Hugging Face file, checked against the file itself
 * when this was written); a download that does not match is deleted, and the file is hashed again each time the engine loads it.
 */

export interface ModelSpec {
  name: string;
  file: string;
  repository: string;
  revision: string;
  bytes: number;
  sha256: string;
  license: string;
  /** Where the file comes from. `file:` URLs are accepted only through the test override. */
  url: string;
}

export const WHISTLE: Omit<ModelSpec, 'url'> = {
  name: 'Whistle',
  file: 'whistle.cact',
  repository: 'Cactus-Compute/whistle',
  revision: 'b358ddadd89b7a713b5aa131f23032d3cca1b251',
  bytes: 16_919_407,
  sha256: 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb',
  license: 'Apache-2.0',
};

/**
 * The model to fetch. The tests point it at a fixture (`PI_KIT_WHISTLE_URL`, `PI_KIT_WHISTLE_SHA256`, `PI_KIT_WHISTLE_BYTES`) so nothing
 * touches the network; the override is ignored when `NODE_ENV=production`, so a packaged app only ever fetches the pinned file.
 */
export function whistleSpec(env: NodeJS.ProcessEnv = process.env): ModelSpec {
  const url = `https://huggingface.co/${WHISTLE.repository}/resolve/${WHISTLE.revision}/${WHISTLE.file}`;
  if (env['NODE_ENV'] === 'production' || !env['PI_KIT_WHISTLE_URL']) return { ...WHISTLE, url };
  return { ...WHISTLE, url: env['PI_KIT_WHISTLE_URL'], sha256: env['PI_KIT_WHISTLE_SHA256'] ?? WHISTLE.sha256, bytes: Number(env['PI_KIT_WHISTLE_BYTES']) || WHISTLE.bytes };
}

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * The model file on disk: where it lives under the data folder, whether it is there, and the one download at a time that
 * fetches it into a `.part` file, checks the size and SHA-256 against the pin and renames it into place. `status()` is what
 * Settings shows (`missing`, `downloading` with the bytes so far, `ready` or `error`), and `remove()` throws the file away.
 */
export class ModelStore {
  private downloading: Promise<void> | undefined;
  private received = 0;
  private abort: AbortController | undefined;
  private failure: string | undefined;

  constructor(
    dataDir: string,
    readonly spec: ModelSpec = whistleSpec(),
  ) {
    this.path = join(dataDir, 'models', 'whistle', spec.file);
  }

  readonly path: string;

  /** The file is there with the pinned size (the full hash is checked by `verify`, when the engine loads it). */
  get present(): boolean {
    try {
      return statSync(this.path).size === this.spec.bytes;
    } catch {
      return false;
    }
  }

  get busy(): boolean {
    return this.downloading !== undefined;
  }

  status(): TranscribeModel {
    const state = this.downloading ? 'downloading' : this.present ? 'ready' : this.failure ? 'error' : 'missing';
    return {
      name: this.spec.name,
      file: this.spec.file,
      bytes: this.spec.bytes,
      sha256: this.spec.sha256,
      source: this.spec.url.startsWith('file:') ? 'a local test fixture' : `huggingface.co/${this.spec.repository}`,
      license: this.spec.license,
      state,
      ...(this.downloading ? { receivedBytes: this.received } : {}),
      ...(this.failure && state !== 'ready' && state !== 'downloading' ? { error: this.failure } : {}),
      path: this.path,
    };
  }

  /** Records a failure to load the file (damaged, not a model) so Settings shows it; a new download or a removal clears it. */
  fail(message: string): void {
    this.failure = message;
  }

  /** Hashes the file on disk against the pin. */
  async verify(): Promise<boolean> {
    if (!this.present) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(this.path)) hash.update(chunk as Buffer);
    return hash.digest('hex') === this.spec.sha256;
  }

  /** Fetches the model. One download at a time; a second call joins the first. Resolves when the verified file is in place. */
  download(): Promise<void> {
    this.downloading ??= this.fetchModel().finally(() => {
      this.downloading = undefined;
      this.abort = undefined;
    });
    return this.downloading;
  }

  cancel(): void {
    this.abort?.abort(new Error('Download cancelled.'));
  }

  remove(): void {
    this.cancel();
    rmSync(this.path, { force: true });
    rmSync(`${this.path}.part`, { force: true });
    this.failure = undefined;
  }

  private async fetchModel(): Promise<void> {
    this.failure = undefined;
    this.received = 0;
    const abort = (this.abort = new AbortController());
    const timer = setTimeout(() => abort.abort(new Error('The download took too long.')), DOWNLOAD_TIMEOUT_MS);
    const part = `${this.path}.part`;
    mkdirSync(dirname(this.path), { recursive: true });
    rmSync(part, { force: true });
    try {
      const source = await this.open(abort.signal);
      const hash = createHash('sha256');
      const check = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          this.received += chunk.length;
          if (this.received > this.spec.bytes) return callback(new Error(`The file is larger than the pinned ${this.spec.bytes} bytes.`));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(source, check, createWriteStream(part, { flags: 'wx', mode: 0o600 }), { signal: abort.signal });
      if (this.received !== this.spec.bytes || hash.digest('hex') !== this.spec.sha256) {
        throw new Error('The downloaded file does not match the pinned size and SHA-256, so it was discarded.');
      }
      await rename(part, this.path);
    } catch (error) {
      rmSync(part, { force: true });
      this.failure = abort.signal.aborted ? String((abort.signal.reason as Error)?.message ?? 'Download cancelled.') : error instanceof Error ? error.message : String(error);
      throw new Error(this.failure, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private async open(signal: AbortSignal): Promise<Readable> {
    const { url } = this.spec;
    if (url.startsWith('file:')) {
      const file = fileURLToPath(url);
      if (!existsSync(file)) throw new Error(`The model fixture ${file} does not exist.`);
      return createReadStream(file);
    }
    const response = await fetch(url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`The download failed: HTTP ${response.status}.`);
    return Readable.fromWeb(response.body as never);
  }
}
