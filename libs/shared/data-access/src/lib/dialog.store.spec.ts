import { TestBed } from '@angular/core/testing';
import { DialogStore } from './dialog.store';

describe('DialogStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows and closes a dialog', () => {
    const dialogs = TestBed.inject(DialogStore);
    dialogs.show({ kind: 'hotkeys' });
    expect(dialogs.current()?.kind).toBe('hotkeys');
    dialogs.close();
    expect(dialogs.current()).toBeUndefined();
  });

  it('askName resolves with the trimmed name, and with undefined when cancelled', async () => {
    const dialogs = TestBed.inject(DialogStore);
    const named = dialogs.askName('old');
    expect(dialogs.current()).toMatchObject({ kind: 'name', current: 'old' });
    dialogs.submitName('  new name ');
    expect(await named).toBe('new name');
    expect(dialogs.current()).toBeUndefined();

    const cancelled = dialogs.askName('', 'Label turn 2', 'Label');
    dialogs.close();
    expect(await cancelled).toBeUndefined();
  });
});
