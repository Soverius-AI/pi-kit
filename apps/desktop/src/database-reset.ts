import type { MessageBoxOptions } from 'electron';
import type { DatabaseBackup } from '@pi-kit/service-host';

export interface DatabaseResetUi {
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
  backup(): Promise<DatabaseBackup>;
  restore(): Promise<DatabaseBackup>;
}

export class DatabaseResetDialog {
  constructor(private readonly ui: DatabaseResetUi) {}

  async offer(reason: 'database-encrypted' | 'database-broken', details: string): Promise<DatabaseBackup | undefined> {
    const { response } = await this.ui.showMessageBox({
      type: 'warning',
      title: 'pi-kit',
      message:
        reason === 'database-encrypted'
          ? 'This version of pi-kit cannot open this encrypted or unrecognized database.'
          : 'The pi-kit database is damaged.',
      detail:
        'Recreating replaces the databases, including database-only feedback, reviews, background agents and pairings. Your pi session files, provider credentials and other settings are kept.\n\n' +
        'An automatic private backup is made before reset. Only after this backup succeeds will pi-kit create empty databases.\n\n' +
        'Quit keeps the existing profile unchanged. Close other pi-kit builds and backends before continuing.\n\n' +
        `Details: ${details}`,
      buttons: ['Quit', 'Delete and recreate database'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return undefined;
    return this.attempt(
      () => this.ui.backup(),
      'The database backup could not be completed. pi-kit will quit.',
      'No replacement backend was started and the original files were kept. If the backup stopped partway, the next start offers to restore them.',
    );
  }

  async offerRestore(details: string): Promise<DatabaseBackup | undefined> {
    const { response } = await this.ui.showMessageBox({
      type: 'warning',
      title: 'pi-kit',
      message: 'A database reset was interrupted.',
      detail:
        'Restore moves the original database files back from the backup folder, so pi-kit starts as it was before the reset. Quit leaves every file where it is.\n\n' +
        `Details: ${details}`,
      buttons: ['Restore original files', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return undefined;
    return this.attempt(
      () => this.ui.restore(),
      'The original database files could not be restored. pi-kit will quit.',
      'No backend was started. Files that were already moved back stay in place; the next start offers to restore the rest.',
    );
  }

  private async attempt(
    operation: () => Promise<DatabaseBackup>,
    message: string,
    after: string,
  ): Promise<DatabaseBackup | undefined> {
    try {
      return await operation();
    } catch (error) {
      await this.ui.showMessageBox({
        type: 'error',
        title: 'pi-kit',
        message,
        detail: `${error instanceof Error ? error.message : 'The operation failed.'}\n\n${after}`,
        buttons: ['Quit'],
        defaultId: 0,
        cancelId: 0,
      });
      return undefined;
    }
  }
}
