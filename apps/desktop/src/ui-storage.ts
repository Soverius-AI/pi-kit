import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_VALUE_LENGTH = 512 * 1024;
const GRAPH_FOLD_PREFIX = 'pk.graph.fold.';

/** These preferences follow the project owner; the renderer wraps their keys for a remote owner. */
const ownerAllowed = (key: string): boolean =>
  ['pi-kit.pinned-chips', 'pk.files.showIgnored'].includes(key) ||
  (key.startsWith(GRAPH_FOLD_PREFIX) && key.length > GRAPH_FOLD_PREFIX.length);

const allowed = (key: string): boolean => {
  if (
    ownerAllowed(key) ||
    [
      'pi-kit.theme',
      'pi-kit.look',
      'pi-kit.showUsage',
      'pi-kit.copilotInspector',
      'pi-kit.entryInstance',
      'pi-kit.workbench-ref.v1',
      'pi-kit.preview-dismissals.v1',
      'pi-kit.preview-auto-open.v1',
      'pi-kit.preview-hint-dismissed.v1',
      'pi-kit.remoteAccess.port',
    ].includes(key)
  )
    return true;
  // Match with-persistence's owner namespace, without admitting wrapped credentials or arbitrary keys.
  try {
    const scoped: unknown = JSON.parse(key);
    return (
      Array.isArray(scoped) &&
      scoped.length === 3 &&
      scoped[0] === 'pi-kit.owner.v1' &&
      typeof scoped[1] === 'string' &&
      scoped[1].length > 0 &&
      typeof scoped[2] === 'string' &&
      ownerAllowed(scoped[2])
    );
  } catch {
    return false;
  }
};

const validValue = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_VALUE_LENGTH;

/** UI copies only; backend settings remain authoritative. Disk I/O never runs in the chat renderer. */
export class UiStorage {
  private values: Record<string, string> = {};
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async load(migrate: () => Promise<unknown>): Promise<void> {
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      saved = await migrate();
    }
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      this.values = Object.fromEntries(
        Object.entries(saved).filter(([key, value]) => allowed(key) && validValue(value)),
      );
    }
    await this.save();
  }

  snapshot(): Record<string, string> {
    return { ...this.values };
  }

  set(key: unknown, value: unknown): Promise<void> {
    if (typeof key !== 'string' || !allowed(key) || !validValue(value))
      return Promise.reject(new Error('Invalid UI preference'));
    this.values[key] = value;
    return this.save();
  }

  flush(): Promise<void> {
    return this.pending;
  }

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
