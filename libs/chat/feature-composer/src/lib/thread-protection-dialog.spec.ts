import { TestBed } from '@angular/core/testing';
import { DialogStore } from '@pi-kit/data-access';
import { ThreadProtectionDialog, type ThreadProtectionDialogInputs } from './thread-protection-dialog';

class DialogPage {
  constructor(readonly root: HTMLElement) {}

  get confirm(): HTMLButtonElement {
    return this.root.querySelector('[data-testid="protection-confirm"]')!;
  }

  get cancel(): HTMLButtonElement {
    return this.root.querySelector('[data-testid="protection-cancel"]')!;
  }

  consent(id: string): HTMLInputElement | null {
    return this.root.querySelector(`[data-consent="${id}"]`);
  }

  check(id: string): void {
    const box = this.consent(id)!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  }

  key(key: string, shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    (document.activeElement ?? this.root).dispatchEvent(event);
    return event;
  }
}

describe('ThreadProtectionDialog', () => {
  const apply = vi.fn();

  beforeEach(() => {
    apply.mockReset();
    TestBed.resetTestingModule();
  });

  async function open(inputs: Omit<ThreadProtectionDialogInputs, 'apply'>) {
    const fixture = TestBed.createComponent(ThreadProtectionDialog);
    for (const [name, value] of Object.entries({ ...inputs, apply })) fixture.componentRef.setInput(name, value);
    await fixture.whenStable();
    return { fixture, page: new DialogPage(fixture.nativeElement) };
  }

  const change = { title: 'confirmTitle', confirmLabel: 'confirm' } as const;

  it('confirms a plain change without any checkbox', async () => {
    const { page } = await open({ ...change, warnings: ['enableWarning'], consents: [] });
    expect(page.root.querySelector('input[type="checkbox"]')).toBeNull();
    page.confirm.click();
    expect(apply).toHaveBeenCalledOnce();
  });

  it('requires every shown consent before confirming', async () => {
    const { fixture, page } = await open({
      ...change,
      warnings: ['recoveryWarning', 'enableWarning'],
      consents: ['recoveryConsent', 'windowsConsent'],
    });
    expect(page.root.textContent).toContain('Earlier sandbox work for this thread may not have stopped');
    expect(page.confirm.disabled).toBe(true);
    page.check('windowsConsent');
    await fixture.whenStable();
    expect(page.confirm.disabled).toBe(true);
    page.check('recoveryConsent');
    await fixture.whenStable();
    expect(page.confirm.disabled).toBe(false);
    page.confirm.click();
    expect(apply).toHaveBeenCalledOnce();
  });

  it('keeps Tab inside the dialog and closes on Escape', async () => {
    const { page } = await open({ ...change, warnings: ['bypassWarning'], consents: ['recoveryConsent'] });
    const close = vi.spyOn(TestBed.inject(DialogStore), 'close');
    page.cancel.focus();
    expect(page.key('Tab', true).defaultPrevented).toBe(false);
    page.consent('recoveryConsent')!.focus();
    expect(page.key('Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(page.cancel);
    expect(page.key('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(page.consent('recoveryConsent'));
    page.key('Escape');
    expect(close).toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
