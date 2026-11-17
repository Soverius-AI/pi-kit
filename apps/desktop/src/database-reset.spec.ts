import type { MessageBoxOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseResetDialog } from './database-reset';

function world(response: number) {
  const saved = { directory: '/scratch/profile/database-backup-unique', files: ['pi-kit.sqlite'] };
  const showMessageBox = vi.fn(async (_options: MessageBoxOptions) => ({ response }));
  const backup = vi.fn(async () => saved);
  const restore = vi.fn(async () => saved);
  return { saved, showMessageBox, backup, restore };
}

describe('explicit database delete and recreate', () => {
  it.each(['database-encrypted', 'database-broken'] as const)(
    'defaults to Quit for %s without touching files',
    async (reason) => {
      const ui = world(0);
      expect(await new DatabaseResetDialog(ui).offer(reason, 'Original database retained.')).toBeUndefined();
      expect(ui.backup).not.toHaveBeenCalled();
      expect(ui.showMessageBox).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          buttons: ['Quit', 'Delete and recreate database'],
          defaultId: 0,
          cancelId: 0,
        }),
      );
      const detail = ui.showMessageBox.mock.calls[0][0].detail!;
      const [copy, details] = detail.split('\n\nDetails: ');
      expect(details).toBe('Original database retained.');
      expect(`${ui.showMessageBox.mock.calls[0][0].message} ${copy}`.split(/\s+/).length).toBeLessThanOrEqual(80);
      for (const text of [
        'feedback',
        'reviews',
        'background agents',
        'pairings',
        'pi session files',
        'provider credentials',
        'other settings',
        'automatic private',
        'Only after this backup succeeds',
      ]) {
        expect(copy).toContain(text);
      }
    },
  );

  it.each(['database-encrypted', 'database-broken'] as const)(
    'backs up %s only after confirmation without a second success dialog',
    async (reason) => {
      const ui = world(1);
      expect(await new DatabaseResetDialog(ui).offer(reason, 'Original database retained.')).toEqual(ui.saved);
      expect(ui.backup).toHaveBeenCalledTimes(1);
      expect(ui.showMessageBox).toHaveBeenCalledTimes(1);
      expect(ui.showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(ui.backup.mock.invocationCallOrder[0]);
      expect(ui.showMessageBox.mock.calls[0][0].detail).not.toContain(ui.saved.directory);
    },
  );

  it('awaits the backup before allowing startup to retry', async () => {
    const ui = world(1);
    let finish!: (value: typeof ui.saved) => void;
    ui.backup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let completed = false;
    const result = new DatabaseResetDialog(ui).offer('database-encrypted', 'Encrypted.').then((value) => {
      completed = true;
      return value;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish(ui.saved);
    expect(await result).toEqual(ui.saved);
  });

  it('returns no retry result after failed backup and shows one Quit-only error', async () => {
    const ui = world(1);
    ui.backup.mockRejectedValueOnce(new Error('A backend is still running.'));
    expect(await new DatabaseResetDialog(ui).offer('database-broken', 'Damaged database retained.')).toBeUndefined();
    expect(ui.backup).toHaveBeenCalledTimes(1);
    expect(ui.showMessageBox).toHaveBeenCalledTimes(2);
    expect(ui.showMessageBox.mock.calls[1][0]).toMatchObject({
      type: 'error',
      buttons: ['Quit'],
      defaultId: 0,
      cancelId: 0,
      detail: expect.stringMatching(/^A backend is still running\.\n\n.*next start offers to restore/),
    });
  });
});

describe('restoring after an interrupted reset', () => {
  it('defaults to Restore, Escape quits, and shows the details', async () => {
    const ui = world(1);
    expect(await new DatabaseResetDialog(ui).offerRestore('A database reset was interrupted.')).toBeUndefined();
    expect(ui.restore).not.toHaveBeenCalled();
    expect(ui.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        buttons: ['Restore original files', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        detail: expect.stringMatching(/\n\nDetails: A database reset was interrupted\.$/),
      }),
    );
  });

  it('restores only after the choice and returns what came back', async () => {
    const ui = world(0);
    expect(await new DatabaseResetDialog(ui).offerRestore('Interrupted.')).toEqual(ui.saved);
    expect(ui.restore).toHaveBeenCalledTimes(1);
    expect(ui.showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(ui.restore.mock.invocationCallOrder[0]);
    expect(ui.backup).not.toHaveBeenCalled();
  });

  it('shows the conflict and quits when the restore fails', async () => {
    const ui = world(0);
    ui.restore.mockRejectedValueOnce(
      new Error('These files exist both in the profile and in the backup: pi-kit.sqlite.'),
    );
    expect(await new DatabaseResetDialog(ui).offerRestore('Interrupted.')).toBeUndefined();
    expect(ui.showMessageBox.mock.calls[1][0]).toMatchObject({
      type: 'error',
      buttons: ['Quit'],
      detail: expect.stringContaining('pi-kit.sqlite'),
    });
  });
});
