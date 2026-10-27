import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DialogStore } from './dialog.store';

@Component({ template: '' })
class TestDialog {}

describe('DialogStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows and closes a dialog', () => {
    const dialogs = TestBed.inject(DialogStore);
    dialogs.show({ kind: 'hotkeys' });
    expect(dialogs.current()?.kind).toBe('hotkeys');
    dialogs.close();
    expect(dialogs.current()).toBeUndefined();
  });

  it('opens and closes a component with inputs', () => {
    const dialogs = TestBed.inject(DialogStore);
    const state = { kind: 'component' as const, component: TestDialog, inputs: { skill: 'example' } };
    dialogs.show(state);
    expect(dialogs.current()).toBe(state);
    dialogs.close();
    expect(dialogs.current()).toBeUndefined();
  });

  it('blocks dismissal and replacement while the component guard is false', async () => {
    const dialogs = TestBed.inject(DialogStore);
    let busy = true;
    const state = { kind: 'component' as const, component: TestDialog, canClose: () => !busy };
    dialogs.show(state);
    dialogs.close();
    expect(dialogs.current()).toBe(state);
    dialogs.show({ kind: 'hotkeys' });
    expect(dialogs.current()).toBe(state);
    expect(await dialogs.askName('old')).toBeUndefined();
    dialogs.submitName('new');
    expect(dialogs.current()).toBe(state);
    busy = false;
    dialogs.show({ kind: 'hotkeys' });
    expect(dialogs.current()?.kind).toBe('hotkeys');
    dialogs.show(state);
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
