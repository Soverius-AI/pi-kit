import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComputerUseState } from '@pi-kit/protocol';
import { ComputerUseStore, SettingsStore } from '@pi-kit/settings/data';
import { ComputerUseSection } from './computer-use-section';

const base: ComputerUseState = {
  installed: true,
  supported: true,
  platform: 'darwin',
  enabled: false,
  host: { name: 'pi-kit', kind: 'app' },
  permissions: null,
  needsRelaunch: false,
};

describe('Settings › Computer use', () => {
  const state = signal<ComputerUseState | undefined>(base);
  const cu = {
    state,
    busy: signal(false),
    error: signal<string | undefined>(undefined),
    load: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    canRelaunch: vi.fn(() => true),
    relaunch: vi.fn(async () => undefined),
  };
  const ids = ['computer-use', 'computer-use-accessibility', 'computer-use-screen', 'computer-use-app'];

  beforeEach(() => {
    vi.clearAllMocks();
    state.set(base);
    TestBed.configureTestingModule({
      providers: [
        { provide: ComputerUseStore, useValue: cu },
        {
          provide: SettingsStore,
          useValue: {
            matches: () => new Set(ids),
            shows: (...wanted: string[]) => wanted.some((id) => ids.includes(id)),
          },
        },
      ],
    });
  });

  const render = () => {
    const f = TestBed.createComponent(ComputerUseSection);
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  };
  const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid=${id}]`);

  it('is off until switched on, and checks no permission until then', () => {
    const { el } = render();
    expect(cu.load).toHaveBeenCalled();
    expect(q(el, 'computer-use-state')?.textContent).toContain('off');
    expect(q(el, 'computer-use-accessibility-state')).toBeNull();
    expect(q(el, 'computer-use-accessibility-open')?.hasAttribute('disabled')).toBe(true);
    q(el, 'computer-use-toggle')!.click();
    expect(cu.setEnabled).toHaveBeenCalledWith(true);
  });

  it('shows what macOS granted and opens the page of what is missing', () => {
    state.set({ ...base, enabled: true, permissions: { accessibility: false, screenRecording: true } });
    const { el } = render();
    expect(q(el, 'computer-use-accessibility-state')?.textContent).toContain('not granted');
    expect(q(el, 'computer-use-screenRecording-state')?.textContent).toContain('granted');
    expect(q(el, 'computer-use-screenRecording-open')?.hasAttribute('disabled')).toBe(true);
    expect(q(el, 'computer-use-permissions-intro')?.textContent).toContain('find pi-kit in the list');
    q(el, 'computer-use-accessibility-open')!.click();
    expect(cu.open).toHaveBeenCalledWith('accessibility');
  });

  it('offers Relaunch after a new Screen Recording grant, but not to a terminal', () => {
    state.set({
      ...base,
      enabled: true,
      permissions: { accessibility: true, screenRecording: true },
      needsRelaunch: true,
    });
    const app = render();
    expect(q(app.el, 'computer-use-relaunch')?.textContent).toContain('starts again');
    q(app.el, 'computer-use-relaunch-now')!.click();
    expect(cu.relaunch).toHaveBeenCalled();

    state.set({
      ...base,
      enabled: true,
      host: { name: 'iTerm', kind: 'terminal' },
      permissions: { accessibility: true, screenRecording: true },
      needsRelaunch: true,
    });
    const terminal = render();
    expect(q(terminal.el, 'computer-use-relaunch-now')).toBeNull();
    expect(q(terminal.el, 'computer-use-relaunch')?.textContent).toContain('Quit iTerm');
  });

  it('explains development and ad-hoc builds', () => {
    state.set({
      ...base,
      enabled: true,
      host: { name: 'Electron', kind: 'development' },
      permissions: { accessibility: false, screenRecording: false },
    });
    expect(q(render().el, 'computer-use-host-note')?.textContent).toContain('Electron');
    state.set({
      ...base,
      enabled: true,
      host: { name: 'pi-kit', kind: 'app', adHoc: true },
      permissions: { accessibility: false, screenRecording: false },
    });
    expect(q(render().el, 'computer-use-host-note')?.textContent).toContain('ad-hoc');
  });

  it('says when pi has no package, and has no permissions on Windows and Linux', () => {
    state.set({ ...base, installed: false });
    const missing = render();
    expect(q(missing.el, 'computer-use-not-installed')).not.toBeNull();
    expect(q(missing.el, 'computer-use-toggle')?.hasAttribute('disabled')).toBe(true);
    state.set({ ...base, platform: 'win32', enabled: true });
    const windows = render();
    expect(q(windows.el, 'computer-use-permissions')).toBeNull();
    expect(windows.el.textContent).toContain('Windows needs no permissions');
    state.set({ ...base, platform: 'linux', enabled: true });
    const linux = render();
    expect(q(linux.el, 'computer-use-permissions')).toBeNull();
    expect(linux.el.textContent).toContain('Linux needs no permissions');
  });

  it('tells a Hyprland session that computer use is read-only', () => {
    state.set({ ...base, platform: 'linux', enabled: true, hyprland: true });
    expect(q(render().el, 'computer-use-hyprland')?.textContent).toContain('read-only');
    state.set({ ...base, platform: 'linux', enabled: true, hyprland: false });
    expect(q(render().el, 'computer-use-hyprland')).toBeNull();
  });
});
