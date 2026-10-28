import { describe, expect, it } from 'vitest';
import { batchOf, FolderChangesService, MAX_BATCH_PATHS, type PathBatch } from './folder-changes.service';

describe('FolderChangesService', () => {
  it('hands a published batch to the folder’s listeners and to every-batch listeners, not to other folders', () => {
    const service = new FolderChangesService();
    const mine: PathBatch[] = [];
    const other: PathBatch[] = [];
    const every: string[] = [];
    service.subscribe('/a', (b) => mine.push(b));
    service.subscribe('/b', (b) => other.push(b));
    service.onBatch((cwd) => every.push(cwd));
    service.publish('/a', batchOf(['x.ts'], 1));
    expect(mine).toEqual([{ paths: ['x.ts'], overflow: false, headMoved: false, at: 1 }]);
    expect(other).toEqual([]);
    expect(every).toEqual(['/a']);
  });

  it('keeps delivering a batch to the other listeners when one throws', () => {
    const service = new FolderChangesService();
    const received: string[][] = [];
    service.subscribe('/a', () => {
      throw new Error('boom');
    });
    service.subscribe('/a', (batch) => received.push(batch.paths));
    expect(() => service.publish('/a', batchOf(['a.ts']))).not.toThrow();
    expect(received).toEqual([['a.ts']]);
  });

  it('stops delivering to a listener that left', () => {
    const service = new FolderChangesService();
    const received: string[][] = [];
    const leave = service.subscribe('/a', (batch) => received.push(batch.paths));
    leave();
    service.publish('/a', batchOf(['a.ts']));
    expect(received).toEqual([]);
  });

  it('caps the paths of a batch and says so', () => {
    const batch = batchOf(Array.from({ length: MAX_BATCH_PATHS + 5 }, (_, i) => `f${i}`));
    expect(batch.paths).toHaveLength(MAX_BATCH_PATHS);
    expect(batch.overflow).toBe(true);
  });
});
