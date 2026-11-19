import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { COPILOT_INSPECTOR_AT_START, RedactionStore, ViewPrefs } from '@pi-kit/data-access';
import { AdvancedSettingsStore, SecretsStore, SettingsStore } from '@pi-kit/settings/data';
import { AdvancedSection } from './advanced-section';

describe('credential storage confirmation', () => {
  const secrets = {
    status: signal({ available: true, credentialsEnabled: true, label: 'Credential Manager' }),
    storageBusy: signal(false),
    storageResult: signal(undefined),
    installed: signal(undefined),
    protection: signal(undefined),
    loadStatus: vi.fn(),
    loadProtection: vi.fn(),
    setCredentialStorage: vi.fn(async () => true),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    secrets.status.set({ available: true, credentialsEnabled: true, label: 'Credential Manager' });
    secrets.storageBusy.set(false);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsStore,
          useValue: {
            shows: (...ids: string[]) => ids.includes('secret-store'),
          },
        },
        { provide: SecretsStore, useValue: secrets },
        { provide: RedactionStore, useValue: { load: vi.fn() } },
        { provide: ViewPrefs, useValue: { roomsPreview: () => false } },
        { provide: COPILOT_INSPECTOR_AT_START, useValue: false },
      ],
    });
    TestBed.overrideComponent(AdvancedSection, {
      set: { providers: [{ provide: AdvancedSettingsStore, useValue: { diagnostics: signal(undefined) } }] },
    });
  });

  it('presents credential storage as a separate opt-in without promising database encryption', async () => {
    secrets.status.set({ available: false, credentialsEnabled: false, label: 'macOS Keychain' });
    const f = TestBed.createComponent(AdvancedSection);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid=store-chip]')!.textContent).toContain('disabled');
    el.querySelector<HTMLButtonElement>('[data-testid=credential-storage-toggle]')!.click();
    f.detectChanges();
    const text = el.querySelector('[role=alertdialog]')!.textContent;
    expect(text).toContain('Touch ID');
    expect(text).toContain('explicitly');
    el.querySelector<HTMLButtonElement>('[data-testid=credential-storage-confirm]')!.click();
    await f.whenStable();
    expect(secrets.setCredentialStorage).toHaveBeenCalledWith(true);
    expect(text).not.toContain('next restart');
    expect(el.querySelector('[data-testid=database-protection]')).toBeNull();
    expect(el.querySelector('[data-testid=export-recovery-key]')).toBeNull();
    expect(el.querySelector('[data-testid=recovery-dialog]')).toBeNull();
  });

  it('warns in a modal, cancels without changing storage, and only disables on confirmation', async () => {
    const f = TestBed.createComponent(AdvancedSection);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const click = (selector: string) => {
      el.querySelector<HTMLButtonElement>(selector)!.click();
      f.detectChanges();
    };
    click('[data-testid=credential-storage-toggle]');
    const dialog = el.querySelector('[role=alertdialog]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('plain text');
    expect(secrets.setCredentialStorage).not.toHaveBeenCalled();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    f.detectChanges();
    expect(el.querySelector('[role=alertdialog]')).toBeNull();
    expect(secrets.setCredentialStorage).not.toHaveBeenCalled();
    click('[data-testid=credential-storage-toggle]');
    click('[data-testid=credential-storage-confirm]');
    await f.whenStable();
    f.detectChanges();
    expect(secrets.setCredentialStorage).toHaveBeenCalledWith(false);
    expect(el.querySelector('[role=alertdialog]')).toBeNull();
  });
});
