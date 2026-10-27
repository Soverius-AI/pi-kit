import { Component, DestroyRef, inject, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DialogStore } from '@pi-kit/data-access';
import { DialogHost } from './dialog-host';

@Component({ selector: 'pk-test-dialog', template: '<p>{{ label() }}</p>' })
class TestDialog {
  readonly label = input('');
  static destroyed = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => TestDialog.destroyed++);
  }
}

describe('DialogHost', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestDialog.destroyed = 0;
  });

  it('mounts a component with inputs outside the stock modal and destroys it on close', () => {
    const dialogs = TestBed.inject(DialogStore);
    const fixture = TestBed.createComponent(DialogHost);
    dialogs.show({ kind: 'component', component: TestDialog, inputs: { label: 'Install skill' } });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('pk-test-dialog')?.textContent).toBe('Install skill');
    expect(el.querySelector('dialog.modal')).toBeNull();
    dialogs.close();
    fixture.detectChanges();
    expect(el.querySelector('pk-test-dialog')).toBeNull();
    expect(TestDialog.destroyed).toBe(1);
  });

  it('still renders a built-in modal after replacing a component', () => {
    const dialogs = TestBed.inject(DialogStore);
    const fixture = TestBed.createComponent(DialogHost);
    dialogs.show({ kind: 'component', component: TestDialog });
    fixture.detectChanges();
    dialogs.show({ kind: 'hotkeys' });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('dialog.modal')).not.toBeNull();
    expect(el.querySelector('pk-test-dialog')).toBeNull();
    expect(TestDialog.destroyed).toBe(1);
  });
});
