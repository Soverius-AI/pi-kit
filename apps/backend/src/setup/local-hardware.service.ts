import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, opendir, readFile, realpath, stat, statfs } from 'node:fs/promises';
import { arch, cpus, freemem, homedir, platform, totalmem } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { type InstalledLocalModel, type LocalHardware, type LocalTool } from '@pi-kit/protocol';
import { z } from 'zod';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { defaultProbes, probeLocalServers } from './detect';
import { localInstallGuide } from './local-install-guide';

export const GIB = 1024 ** 3;

/** Executable discovery also covers the usual package-manager locations in desktop launch environments. */
export async function localExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : process.platform === 'linux' ? ['/home/linuxbrew/.linuxbrew/bin', join(homedir(), '.linuxbrew/bin'), join(homedir(), '.local/bin'), '/usr/local/bin'] : [];
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const dir of [...new Set([...(env['PATH'] ?? '').split(delimiter).filter(Boolean), ...extra])]) {
    for (const file of names) {
      const path = join(dir, file);
      try { if ((await stat(path)).isFile()) { await access(path, constants.X_OK); return path; } } catch { /* try the next location */ }
    }
  }
  return undefined;
}

export function localCommand(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { timeout, maxBuffer: 64_000, windowsHide: true }, (error, stdout, stderr) => error ? reject(error) : resolve(`${stdout}\n${stderr}`.trim())));
}

/** Read-only machine facts and a bounded scan of explicitly selected/common model folders. */
@Injectable()
export class LocalHardwareService {
  private readonly known = new Map<string, InstalledLocalModel>();
  constructor(@Inject(CONFIG) private readonly config: Pick<BackendConfig, 'dataDir' | 'localRuntime'>) {}

  modelsDirectory(): string { return join(this.config.dataDir, 'local-models'); }

  async diskFree(): Promise<number> {
    const info = await statfs(this.config.dataDir);
    return Number(info.bavail) * Number(info.bsize);
  }

  async detect(directory?: string, extraProbes: ReturnType<typeof defaultProbes> = []): Promise<LocalHardware> {
    const [tools, models, servers, diskFreeBytes, acceleration] = await Promise.all([
      Promise.all((['llama-server', 'llama-swap', 'brew'] as const).map((id) => this.tool(id))),
      this.scan(directory), probeLocalServers([...defaultProbes(), ...extraProbes]), this.diskFree(), this.acceleration(),
    ]);
    const guide = localInstallGuide(platform(), platform() === 'linux' && !!await localExecutable('apt-get'), tools.some((tool) => tool.id === 'brew' && !!tool.path));
    const supported = (platform() === 'darwin' || platform() === 'linux') && tools.some((tool) => tool.id === 'brew' && tool.path);
    return {
      platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'Unknown CPU', cores: cpus().length,
      ramBytes: totalmem(), freeRamBytes: freemem(), diskFreeBytes, acceleration, tools, models, servers,
      installer: {
        supported,
        reason: supported ? 'Use the existing Homebrew installation. Already installed tools are reused.' : 'Guided tool installation requires Homebrew on macOS/Linux. Install the tools from their official instructions, then detect again. Existing servers and model files can still be reused.',
        sources: ['https://formulae.brew.sh/formula/llama.cpp', 'https://github.com/mostlygeek/llama-swap#installation'],
        ...(guide ? { guide } : {}),
      },
    };
  }

  private async tool(id: LocalTool['id']): Promise<LocalTool> {
    const path = await localExecutable(id);
    if (!path) return { id };
    try {
      const version = await localCommand(path, ['--version'], this.config.localRuntime?.probeMs ?? 3000);
      const reported = version.split('\n').find((line) => /\bversion\b|^Homebrew\b/i.test(line));
      return { id, path, ...(reported ? { version: reported.trim().slice(0, 300) } : {}) };
    } catch { return { id, path }; }
  }

  private async acceleration(): Promise<LocalHardware['acceleration']> {
    if (platform() === 'darwin' && arch() === 'arm64') return { kind: 'metal', name: cpus()[0]?.model ?? 'Apple Silicon', memoryBytes: totalmem(), sharedMemory: true };
    const nvidia = await localExecutable('nvidia-smi');
    if (nvidia) {
      try {
        const text = await localCommand(nvidia, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], this.config.localRuntime?.probeMs ?? 3000);
        const [name, memory] = text.split('\n')[0].split(',').map((part) => part.trim());
        if (name && Number.isFinite(Number(memory))) return { kind: 'cuda', name, memoryBytes: Number(memory) * 1024 ** 2, sharedMemory: false };
      } catch { /* report the CPU path without promising unverified GPU support */ }
    }
    return { kind: 'cpu', name: 'CPU; GPU acceleration not verified', sharedMemory: false };
  }

  private async scan(directory?: string): Promise<InstalledLocalModel[]> {
    if (directory) {
      directory = directory === '~' ? homedir() : directory.startsWith('~/') ? join(homedir(), directory.slice(2)) : directory;
      try {
        if (!isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error('Not an absolute directory');
        await access(directory, constants.R_OK | constants.X_OK);
      } catch (cause) { throw new BadRequestException('Select an existing readable model directory using its full path or ~/path.', { cause }); }
    }
    const roots = [this.modelsDirectory(), ...(directory ? [directory] : this.config.localRuntime?.modelDirectories ?? [join(homedir(), 'models'), join(homedir(), '.cache/llama.cpp')])];
    const found: InstalledLocalModel[] = [];
    const visited = new Set<string>();
    let examined = 0;
    const walk = async (folder: string, depth: number): Promise<void> => {
      let actual: string;
      try { actual = await realpath(folder); } catch { return; }
      if (visited.has(actual)) return;
      visited.add(actual);
      const entries = await opendir(actual).catch(() => undefined);
      if (!entries) return;
      for await (const entry of entries) {
        if (++examined > 1000 || found.length >= 100) return;
        const path = join(actual, entry.name);
        if (entry.isDirectory() && depth < 2) await walk(path, depth + 1);
        else if ((entry.isFile() || entry.isSymbolicLink()) && /\.gguf$/i.test(entry.name) && !/mmproj|-\d{5}-of-\d{5}/i.test(entry.name)) {
          const model = await this.describe(path);
          if (model) found.push(model);
        }
      }
    };
    for (const root of roots) await walk(root, 0);
    const unique = [...new Map(found.map((model) => [model.id, model])).values()];
    for (const model of unique) this.remember(model);
    return unique;
  }

  async describe(path: string): Promise<InstalledLocalModel | undefined> {
    let file;
    try {
      const actual = await realpath(path);
      const info = await stat(actual);
      if (!info.isFile() || info.size < 8) return undefined;
      file = await open(actual, 'r');
      const magic = Buffer.alloc(4);
      await file.read(magic, 0, 4, 0);
      if (magic.toString('ascii') !== 'GGUF') return undefined;
      let metadata: { source?: string; sha256?: string; file?: string } = {};
      const managed = await realpath(this.modelsDirectory()).catch(() => undefined);
      if (managed && dirname(actual) === managed) {
        try {
          if ((await stat(`${actual}.json`)).size < 16_000) metadata = z.object({ source: z.string().max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/), file: z.string().max(500).optional() }).parse(JSON.parse(await readFile(`${actual}.json`, 'utf8')));
        } catch { /* a manually copied model has no managed download record */ }
      }
      return { id: createHash('sha256').update(actual).digest('hex'), path: actual, file: basename(actual), bytes: info.size, ...metadata };
    } catch { return undefined; }
    finally { await file?.close(); }
  }

  remember(model: InstalledLocalModel): void {
    this.known.delete(model.id);
    this.known.set(model.id, model);
    while (this.known.size > 200) {
      const oldest = this.known.keys().next().value;
      if (!oldest) break;
      this.known.delete(oldest);
    }
  }

  forget(id: string): void { this.known.delete(id); }

  async model(id: string): Promise<InstalledLocalModel> {
    if (!this.known.has(id)) await this.scan();
    const known = this.known.get(id);
    const fresh = known && await this.describe(known.path);
    if (!fresh) throw new Error('The model file is missing or invalid. Select its folder and detect again.');
    return { ...known, ...fresh };
  }
}
