import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const allowed = (key: string): boolean =>
  ['pi-kit.theme', 'pi-kit.look', 'pi-kit.showUsage', 'pi-kit.copilotInspector', 'pi-kit.pinned-chips', 'pk.files.showIgnored'].includes(key) || key.startsWith('pk.graph.fold.');

/** UI copies only; backend settings remain authoritative. Disk I/O never runs in the chat renderer. */
export class UiStorage {
  private values: Record<string, string> = {};
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async load(migrate: () => Promise<unknown>): Promise<void> {
    let saved: unknown;
    try { saved = JSON.parse(await readFile(this.file, 'utf8')); }
    catch { saved = await migrate(); }
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      this.values = Object.fromEntries(Object.entries(saved).filter(([key, value]) => allowed(key) && typeof value === 'string'));
    }
    await this.save();
  }

  snapshot(): Record<string, string> { return { ...this.values }; }

  set(key: unknown, value: unknown): Promise<void> {
    if (typeof key !== 'string' || !allowed(key) || typeof value !== 'string' || value.length > 512 * 1024) return Promise.reject(new Error('Invalid UI preference'));
    this.values[key] = value;
    return this.save();
  }

  flush(): Promise<void> { return this.pending; }

  private save(): Promise<void> {
    const body = JSON.stringify(this.values);
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', body, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
    };
    this.pending = this.pending.catch(() => undefined).then(write);
    return this.pending;
  }
}
