import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ThreadProtectionStore } from '@pi-kit/chat/data';
import { DialogStore } from '@pi-kit/data-access';
import type { ThreadProtection } from '@pi-kit/protocol';
import { ThreadProtectionDialog } from './thread-protection-dialog';
import { ThreadProtectionPicker } from './thread-protection-picker';

class PickerPage {
  static key(element: Element, key: string, shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event;
  }

  static menu(): HTMLElement {
    return document.querySelector<HTMLElement>('pk-command-menu')!;
  }

  static option(id: string): HTMLElement {
    return PickerPage.menu().querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  }

  static dialog() {
    const state = TestBed.inject(DialogStore).current();
    if (state?.kind !== 'component') throw new Error('Missing consent dialog');
    return state;
  }

  static apply(): void {
    (PickerPage.dialog().inputs?.['apply'] as () => void)();
  }
}

describe('ThreadProtectionPicker', () => {
  const protection = signal<ThreadProtection | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const canOpen = signal(true);
  const canChange = signal(true);
  const loading = signal(false);
  const pending = signal(false);
  const pendingStatus = signal<'saving' | 'settingUp' | undefined>(undefined);
  const threadId = signal<string | undefined>('a');
  const store = {
    protection,
    error,
    canOpen,
    canChange,
    loading,
    pending,
    pendingStatus,
    threadId,
    mode: () => protection()?.mode ?? 'bypass',
    remote: false,
    change: vi.fn(),
    setupWindows: vi.fn(),
    retry: vi.fn(),
  };
  const { key, menu, option, dialog, apply } = PickerPage;

  const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  });
  afterAll(() => {
    if (scrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoView);
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  beforeEach(() => {
    protection.set({
      mode: 'bypass',
      state: 'bypass',
      generation: 0,
      experimentalWindowsAccepted: false,
      platform: 'darwin',
      reason: null,
    });
    error.set(undefined);
    canOpen.set(true);
    canChange.set(true);
    loading.set(false);
    pending.set(false);
    pendingStatus.set(undefined);
    threadId.set('a');
    store.change.mockReset();
    store.setupWindows.mockReset();
    store.retry.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: ThreadProtectionStore, useValue: store }] });
  });

  async function setup() {
    const fixture = TestBed.createComponent(ThreadProtectionPicker);
    await fixture.whenStable();
    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="protection-chip"]');
    return { fixture, trigger };
  }

  it('asks for consent before changing the mode and sends it for the thread it was opened on', async () => {
    const { fixture, trigger } = await setup();
    expect(trigger.getAttribute('aria-label')).toBe('Thread protection: Bypass · No sandbox (Bypass)');
    trigger.click();
    await fixture.whenStable();
    expect(document.activeElement).toBe(menu());
    expect(menu().querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(menu().querySelector('.group')).toBeNull();
    expect(document.querySelector('[data-testid="protection-coverage"]')?.textContent).toContain(
      'Tools run on the host',
    );
    option('sandboxed').click();
    await fixture.whenStable();
    expect(menu()).toBeNull();
    expect(store.change).not.toHaveBeenCalled();
    expect(dialog().component).toBe(ThreadProtectionDialog);
    expect(dialog().inputs).toMatchObject({ title: 'confirmTitle', warnings: ['enableWarning'], consents: [] });
    threadId.set('b');
    apply();
    expect(store.change).toHaveBeenCalledWith({ mode: 'sandboxed' }, 'a');
  });

  it('treats picking the current mode as a no-op outside recovery', async () => {
    const { fixture, trigger } = await setup();
    trigger.click();
    await fixture.whenStable();
    option('bypass').click();
    expect(TestBed.inject(DialogStore).current()).toBeUndefined();
  });

  it('owns Arrow/Home/End/Enter navigation, Escape returns focus and Tab closes without preventing traversal', async () => {
    const { fixture, trigger } = await setup();
    key(trigger, 'ArrowDown');
    await fixture.whenStable();
    expect(option('bypass').getAttribute('aria-selected')).toBe('true');
    for (const [pressed, expected] of [
      ['ArrowDown', 'sandboxed'],
      ['ArrowUp', 'bypass'],
      ['End', 'sandboxed'],
      ['Home', 'bypass'],
    ] as const) {
      key(menu(), pressed);
      await fixture.whenStable();
      expect(menu().getAttribute('aria-activedescendant')).toBe(option(expected).id);
    }
    key(menu(), 'Escape');
    await fixture.whenStable();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    await fixture.whenStable();
    expect(key(menu(), 'Tab').defaultPrevented).toBe(false);
    await fixture.whenStable();
    expect(menu()).toBeNull();
    key(trigger, 'End');
    await fixture.whenStable();
    key(menu(), 'Enter');
    await fixture.whenStable();
    expect(dialog().inputs?.['warnings']).toEqual(['enableWarning']);
  });

  it('opens on a read error so Refresh is reachable, showing the error as secondary detail', async () => {
    protection.set(undefined);
    error.set('offline');
    canChange.set(false);
    const { fixture, trigger } = await setup();
    expect(trigger.disabled).toBe(false);
    expect(trigger.querySelector('.bg-warning')).not.toBeNull();
    trigger.click();
    await fixture.whenStable();
    expect(document.querySelector('[data-testid="protection-detail"]')?.getAttribute('role')).toBe('alert');
    expect(document.querySelector('[data-testid="protection-detail"]')?.textContent).toContain('offline');
    expect(option('sandboxed').getAttribute('aria-disabled')).toBe('true');
    option('sandboxed').click();
    expect(TestBed.inject(DialogStore).current()).toBeUndefined();
    const refresh = document.querySelector<HTMLButtonElement>('[data-testid="protection-refresh"]')!;
    refresh.click();
    expect(store.retry).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(menu());
    loading.set(true);
    await fixture.whenStable();
    expect(menu()).not.toBeNull();
    expect(refresh.disabled).toBe(true);
  });

  it('shows the translated state with the technical reason under it and closes on a thread switch', async () => {
    protection.set({
      mode: 'sandboxed',
      state: 'unavailable',
      generation: 1,
      experimentalWindowsAccepted: false,
      platform: 'win32',
      reason: 'spawn EPERM',
    });
    const { fixture, trigger } = await setup();
    expect(trigger.getAttribute('aria-label')).toBe('Thread protection: Sandboxed · Sandbox unavailable');
    trigger.click();
    await fixture.whenStable();
    const detail = document.querySelector('[data-testid="protection-detail"]');
    expect(document.querySelector('[data-testid="protection-setup"]')).toBeNull();
    expect(detail?.textContent).toContain('spawn EPERM');
    expect(detail?.getAttribute('role')).toBeNull();
    expect(document.querySelector('[data-testid="protection-coverage"]')?.textContent).toContain(
      'Experimental on Windows',
    );
    threadId.set('b');
    await fixture.whenStable();
    expect(menu()).toBeNull();
  });

  it.each([
    ['bypass', 'bypassWarning', { mode: 'bypass', confirmBypass: true, confirmRecovery: true }],
    ['sandboxed', 'enableWarning', { mode: 'sandboxed', confirmRecovery: true }],
  ] as const)(
    'lets recovery pick %s, including the current mode, and confirms the recovery',
    async (mode, warning, body) => {
      protection.set({
        mode: 'sandboxed',
        state: 'recovery-required',
        generation: 2,
        experimentalWindowsAccepted: true,
        platform: 'win32',
        reason: null,
      });
      const { fixture, trigger } = await setup();
      trigger.click();
      await fixture.whenStable();
      option(mode).click();
      expect(dialog().inputs).toMatchObject({ warnings: ['recoveryWarning', warning], consents: ['recoveryConsent'] });
      apply();
      expect(store.change).toHaveBeenCalledWith(body, 'a');
    },
  );

  it.each([
    ['win32', false, true],
    ['win32', true, false],
    ['darwin', false, false],
  ] as const)('on %s with prior consent %s asks for Windows consent: %s', async (platform, accepted, windows) => {
    protection.set({ ...protection()!, platform, experimentalWindowsAccepted: accepted });
    const { fixture, trigger } = await setup();
    trigger.click();
    await fixture.whenStable();
    option('sandboxed').click();
    expect(dialog().inputs?.['consents']).toEqual(windows ? ['windowsConsent'] : []);
    apply();
    expect(store.change).toHaveBeenCalledWith(
      windows ? { mode: 'sandboxed', experimentalWindowsAccepted: true } : { mode: 'sandboxed' },
      'a',
    );
  });

  it('offers the Windows setup only while setup is required, and runs it after consent for that thread', async () => {
    protection.set({
      mode: 'sandboxed',
      state: 'setup-required',
      generation: 1,
      experimentalWindowsAccepted: true,
      platform: 'win32',
      reason: 'srt: setup has not been run',
    });
    const { fixture, trigger } = await setup();
    expect(trigger.getAttribute('aria-label')).toBe('Thread protection: Sandboxed · Windows sandbox needs setup');
    expect(trigger.querySelector('.bg-warning')).not.toBeNull();
    trigger.click();
    await fixture.whenStable();
    const action = document.querySelector<HTMLButtonElement>('[data-testid="protection-setup"]')!;
    expect(document.querySelector('[data-testid="protection-refresh"]')).not.toBeNull();
    canChange.set(false);
    await fixture.whenStable();
    expect(action.disabled).toBe(true);
    canChange.set(true);
    await fixture.whenStable();
    action.click();
    await fixture.whenStable();
    expect(menu()).toBeNull();
    expect(dialog().inputs).toMatchObject({
      title: 'setupTitle',
      confirmLabel: 'setupConfirm',
      warnings: ['setupWarning'],
      consents: ['setupConsent'],
    });
    threadId.set('b');
    apply();
    expect(store.setupWindows).toHaveBeenCalledWith('a');
    expect(store.change).not.toHaveBeenCalled();
    pendingStatus.set('settingUp');
    await fixture.whenStable();
    expect(trigger.getAttribute('aria-label')).toContain('Setting up the Windows sandbox');
  });

  it('shows a read-only badge on remote owners', async () => {
    protection.set({ ...protection()!, mode: 'sandboxed', state: 'setup-required', platform: 'win32' });
    TestBed.overrideProvider(ThreadProtectionStore, { useValue: { ...store, remote: true } });
    const { fixture, trigger } = await setup();
    expect(trigger).toBeNull();
    expect(document.querySelector('[data-testid="protection-setup"]')).toBeNull();
    const badge = fixture.nativeElement.querySelector('pk-protection-badge');
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe('Thread protection: Sandboxed · Windows sandbox needs setup');
  });
});
