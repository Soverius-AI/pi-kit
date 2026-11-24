import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RoomDialog } from './room-dialog';

@Component({
  imports: [RoomDialog],
  template: `
    <button data-testid="opener" (click)="open.set(true)">Edit</button>
    <div tabindex="-1" (keydown.escape)="escaped.set(escaped() + 1)">
      @if (open()) {
        <pk-room-dialog
          title="Edit memory"
          closeLabel="Close"
          [busy]="busy()"
          [error]="error()"
          (closed)="open.set(false)"
        >
          <label>Note<input /></label>
          <button roomDialogActions type="button" [disabled]="busy()">Save</button>
        </pk-room-dialog>
      }
    </div>
  `,
})
class DialogHost {
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | undefined>(undefined);
  readonly escaped = signal(0);
}

describe('room editor dialog', () => {
  async function setup() {
    const fixture = TestBed.createComponent(DialogHost);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const opener = root.querySelector<HTMLButtonElement>('[data-testid=opener]')!;
    opener.focus();
    opener.click();
    await fixture.whenStable();
    const dialog = root.querySelector<HTMLElement>('[role=dialog]')!;
    return { fixture, root, opener, dialog };
  }
  it('labels and focuses the editor, then returns focus without propagating Escape to the room sidebar', async () => {
    const { fixture, root, opener, dialog } = await setup();
    expect(root.querySelector(`#${dialog.getAttribute('aria-labelledby')}`)?.textContent).toBe('Edit memory');
    expect(dialog.contains(document.activeElement)).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(root.querySelector('[role=dialog]')).toBeNull();
    expect(fixture.componentInstance.escaped()).toBe(0);
    expect(document.activeElement).toBe(opener);
  });
  it('keeps keyboard focus and actionable errors inside while saving, with Close still available', async () => {
    const { fixture, root, dialog } = await setup();
    fixture.componentInstance.busy.set(true);
    fixture.componentInstance.error.set('Could not save. Try again.');
    await fixture.whenStable();
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Could not save');
    expect(root.querySelector<HTMLButtonElement>('[roomDialogActions]')?.disabled).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-testid=room-dialog-close]')!.click();
    await fixture.whenStable();
    expect(root.querySelector('[role=dialog]')).toBeNull();
  });
  it('closes on backdrop click', async () => {
    const { fixture, root } = await setup();
    root.querySelector<HTMLButtonElement>('.pk-backdrop')!.click();
    await fixture.whenStable();
    expect(root.querySelector('[role=dialog]')).toBeNull();
  });
});
