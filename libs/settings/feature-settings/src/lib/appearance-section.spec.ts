import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ThemeStore, type ThemePreference, ViewPrefs } from '@pi-kit/data-access';
import { SettingsStore } from '@pi-kit/settings/data';
import { AppearanceSection } from './appearance-section';

describe('Settings › Appearance theme', () => {
  const preference = signal<ThemePreference>('system');
  const setTheme = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    preference.set('system');
    TestBed.configureTestingModule({
      providers: [
        { provide: ThemeStore, useValue: { preference } },
        {
          provide: ViewPrefs,
          useValue: { proseSize: () => 14, codeSize: () => 13, density: () => 'comfortable' },
        },
        {
          provide: SettingsStore,
          useValue: {
            matches: () => new Set(['theme']),
            shows: (...ids: string[]) => ids.includes('theme'),
            setTheme,
          },
        },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(AppearanceSection);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const select = element.querySelector<HTMLSelectElement>('select[aria-labelledby="lbl-theme"]')!;
    return { fixture, element, select };
  }

  it('offers all themes, including System and Omarchy, in a labeled select', () => {
    const { element, select } = render();
    expect(element.querySelector('#lbl-theme')?.textContent).toBe('Theme');
    expect(Array.from(select.options, (option) => [option.value, option.textContent?.trim()])).toEqual([
      ['system', 'System'],
      ['pi-dark', 'Dark'],
      ['pi-light', 'Light'],
      ['pi-soverius', 'Soverius'],
      ['pi-copilotkit', 'CopilotKit'],
      ['pi-omarchy', 'Omarchy'],
    ]);
  });

  it('shows a restored named theme when the options are first rendered', () => {
    preference.set('pi-omarchy');
    const { select } = render();
    expect(select.value).toBe('pi-omarchy');
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('persists Omarchy when selected', () => {
    const { select } = render();
    select.value = 'pi-omarchy';
    select.dispatchEvent(new Event('change'));
    expect(setTheme).toHaveBeenCalledExactlyOnceWith('pi-omarchy');
  });

  it('does not persist an unregistered theme value', () => {
    const { select } = render();
    const invalid = document.createElement('option');
    invalid.value = 'unregistered';
    select.add(invalid);
    select.value = invalid.value;
    select.dispatchEvent(new Event('change'));
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('keeps the selected value in sync with the store preference', () => {
    const { fixture, select } = render();
    expect(select.value).toBe('system');
    for (const value of ['pi-omarchy', 'pi-light', 'system'] as const) {
      preference.set(value);
      fixture.detectChanges();
      expect(select.value).toBe(value);
    }
    expect(setTheme).not.toHaveBeenCalled();
  });
});
