import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiStore } from '@pi-kit/data-access';
import { ConnectorsStore, PackagesStore, SettingsStore } from '@pi-kit/settings/data';
import { AttendantStore } from '@pi-kit/threads/api';
import type { SettingsSectionId } from '@pi-kit/ui';
import { SettingsWindow } from './settings-window';

describe('Settings navigation package loading', () => {
  const section = signal<SettingsSectionId>('skills');
  const search = signal('');
  const packages = { load: vi.fn(async () => undefined) };
  const attendant = { enabled: () => false, load: vi.fn(async () => undefined) };
  const settings = {
    section,
    visibleSections: computed<SettingsSectionId[]>(() =>
      search() ? (search().includes('package') ? ['extensions'] : ['skills']) : [section()],
    ),
    select: vi.fn((id: SettingsSectionId) => {
      section.set(id);
      search.set('');
    }),
    setSearch: vi.fn((value: string) => search.set(value)),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    section.set('skills');
    search.set('');
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsStore, useValue: settings },
        { provide: PackagesStore, useValue: packages },
        { provide: AttendantStore, useValue: attendant },
        { provide: ConnectorsStore, useValue: {} },
      ],
    });
    TestBed.overrideComponent(SettingsWindow, {
      set: {
        imports: [],
        template: `
      <button data-testid="extensions" (click)="selectSection('extensions')">Extensions</button>
      <button data-testid="skills" (click)="selectSection('skills')">Skills</button>
      <input data-testid="search" (input)="searchSettings($any($event.target).value)" />
    `,
      },
    });
  });
  const render = () => {
    const f = TestBed.createComponent(SettingsWindow);
    f.detectChanges();
    return f;
  };

  it('does not load packages when opening Skills', () => {
    TestBed.inject(UiStore).openSettings('skills');
    const f = render();
    f.detectChanges();
    expect(attendant.load).toHaveBeenCalledOnce();
    expect(packages.load).not.toHaveBeenCalled();
  });

  it('loads once per direct Extensions open and refreshes when reopened', () => {
    section.set('extensions');
    const ui = TestBed.inject(UiStore);
    ui.openSettings('extensions');
    const f = render();
    f.detectChanges();
    expect(packages.load).toHaveBeenCalledOnce();
    ui.closeSettings();
    f.detectChanges();
    ui.openSettings('extensions');
    f.detectChanges();
    expect(packages.load).toHaveBeenCalledTimes(2);
  });

  it('loads on entering Extensions, not on repeated selection or unrelated renders', () => {
    TestBed.inject(UiStore).openSettings('skills');
    const f = render();
    const click = (id: string) => {
      f.nativeElement.querySelector(`[data-testid=${id}]`).click();
      f.detectChanges();
    };
    click('extensions');
    click('extensions');
    f.detectChanges();
    expect(packages.load).toHaveBeenCalledOnce();
    click('skills');
    click('extensions');
    expect(packages.load).toHaveBeenCalledTimes(2);
  });

  it('loads when settings search first reveals Extensions, not on every keystroke', () => {
    TestBed.inject(UiStore).openSettings('skills');
    const f = render();
    const type = (value: string) => {
      const input = f.nativeElement.querySelector('[data-testid=search]');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      f.detectChanges();
    };
    type('package');
    type('packages');
    expect(packages.load).toHaveBeenCalledOnce();
    type('skills');
    type('package');
    expect(packages.load).toHaveBeenCalledTimes(2);
  });
});
