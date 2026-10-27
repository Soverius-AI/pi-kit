import { TranslocoService } from '@jsverse/transloco';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiStore } from '@pi-kit/data-access';
import { ThreadsStore } from '@pi-kit/threads/api';
import { PanelSwitcher } from './panel-switcher';
import { ShellStore } from './shell.store';

describe('PanelSwitcher', () => {
  const panel = signal<string | undefined>(undefined);
  const selectedId = signal<string | undefined>('thread-1');
  const disabled = signal(false);
  const togglePanel = vi.fn((id: string) => panel.set(panel() === id ? undefined : id));

  beforeEach(() => {
    panel.set(undefined);
    selectedId.set('thread-1');
    disabled.set(false);
    togglePanel.mockClear();
    vi.stubGlobal('piKit', { setBrowserViewport: vi.fn() });
    TestBed.configureTestingModule({
      providers: [
        { provide: UiStore, useValue: { panel, togglePanel } },
        { provide: ThreadsStore, useValue: { selectedId } },
        {
          provide: ShellStore,
          useValue: {
            treeDisabled: disabled,
            filesDisabled: disabled,
            changesDisabled: disabled,
            terminalDisabled: disabled,
          },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  async function draw() {
    const fixture = TestBed.createComponent(PanelSwitcher);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const trigger = root.querySelector<HTMLButtonElement>('.panel-pocket')!;
    const open = async () => {
      // jsdom's programmatic click does not focus the trigger as a real pointer click does.
      trigger.style.display = 'inline-flex';
      trigger.focus();
      trigger.click();
      await fixture.whenStable();
      return document.querySelector<HTMLElement>('[role="menu"]')!;
    };
    return { fixture, root, trigger, open };
  }

  it('offers the same actions in the popup and toggles the selected panel', async () => {
    panel.set('files');
    const { fixture, root, trigger, open } = await draw();
    expect(root.querySelector('[aria-label="Files"]')?.getAttribute('aria-pressed')).toBe('true');
    let menu = await open();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'));
    expect(items.map((item) => item.textContent?.trim().replace('✓', '').trim())).toEqual([
      'Tree',
      'Files',
      'Changes',
      'Terminal',
      'Agents',
      'Artifacts',
    ]);
    expect(items[1].getAttribute('aria-checked')).toBe('true');
    items[3].click();
    await fixture.whenStable();
    expect(panel()).toBe('terminal');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="menu"]')).toBeNull();

    menu = await open();
    menu.querySelectorAll<HTMLButtonElement>('button')[3].click();
    await fixture.whenStable();
    expect(panel()).toBeUndefined();
  });

  it('updates the open menu and its accessible trigger when the language changes', async () => {
    const { fixture, root, trigger, open } = await draw();
    const menu = await open();
    TestBed.inject(TranslocoService).setActiveLang('de');
    await fixture.whenStable();
    expect(trigger.getAttribute('aria-label')).toBe('Seitenleisten');
    expect(root.querySelector('[aria-label="Dateien"]')).not.toBeNull();
    expect(menu.querySelectorAll('button')[2].textContent?.trim()).toBe('Änderungen');
    menu.querySelectorAll<HTMLButtonElement>('button')[2].click();
    await fixture.whenStable();
    expect(panel()).toBe('changes');
  });

  it('keeps unavailable actions disabled in both presentations', async () => {
    disabled.set(true);
    selectedId.set(undefined);
    const { root, open } = await draw();
    const menu = await open();
    expect(root.querySelectorAll('.panel-buttons button:disabled')).toHaveLength(6);
    expect(menu.querySelectorAll('button:disabled')).toHaveLength(6);
    menu.querySelectorAll<HTMLButtonElement>('button').forEach((button) => button.click());
    expect(togglePanel).not.toHaveBeenCalled();
  });

  it('opens from the keyboard and returns focus to the trigger on Escape', async () => {
    const { fixture, trigger } = await draw();
    // jsdom does not evaluate container queries; expose the compact trigger for focus checks.
    trigger.style.display = 'inline-flex';
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
    await fixture.whenStable();
    const first = document.querySelector<HTMLButtonElement>('[role="menu"] button')!;
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await fixture.whenStable();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
