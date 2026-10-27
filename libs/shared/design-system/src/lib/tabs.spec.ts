import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PkTabs, PkTabPanel } from './tabs';
import { PkScrollArea } from './scroll-area';

@Component({
  selector: 'pk-tabs-host',
  imports: [PkTabs, PkTabPanel, PkScrollArea],
  template: `
    <pk-tabs label="Models" [(value)]="selected">
      <pk-tab-panel value="download" label="Downloads"><input aria-label="Search draft" /></pk-tab-panel>
      <pk-tab-panel value="disabled" label="Unavailable" [disabled]="true">Unavailable</pk-tab-panel>
      @if (installed()) {
        <pk-tab-panel value="installed" label="Installed" [count]="12">Installed files</pk-tab-panel>
      }
      <pk-tab-panel value="machine" label="Machine">Hardware</pk-tab-panel>
    </pk-tabs>
    <pk-tabs label="Other models"><pk-tab-panel value="download" label="Downloads">Other</pk-tab-panel></pk-tabs>
    <pk-scroll-area label="Model results" maxHeight="20rem"><button type="button">A model</button></pk-scroll-area>
  `,
})
class Host {
  readonly selected = signal('download');
  readonly installed = signal(true);
}

describe('tabs and scroll areas', () => {
  const render = () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const buttons = () =>
      Array.from(
        root.querySelectorAll<HTMLButtonElement>('[role=tablist]')[0].querySelectorAll<HTMLButtonElement>('[role=tab]'),
      );
    return { fixture, root, buttons };
  };

  it('links each tab to a uniquely named panel and keeps inactive drafts mounted', () => {
    const { fixture, root, buttons } = render();
    const draft = root.querySelector<HTMLInputElement>('[aria-label="Search draft"]')!;
    draft.value = 'Qwen';
    buttons()[2].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selected()).toBe('installed');
    for (const button of buttons()) {
      const panel = root.querySelector<HTMLElement>(`#${button.getAttribute('aria-controls')}`)!;
      expect(panel.getAttribute('aria-labelledby')).toBe(button.id);
      expect(panel.hidden).toBe(button.getAttribute('aria-selected') !== 'true');
    }
    buttons()[0].click();
    fixture.detectChanges();
    expect(draft.value).toBe('Qwen');
    const ids = Array.from(root.querySelectorAll('[id]')).map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('moves focus and selection with arrows, Home and End, skipping disabled tabs and wrapping', () => {
    const { fixture, buttons } = render();
    const key = (button: HTMLButtonElement, value: string) => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
      fixture.detectChanges();
    };
    buttons()[0].focus();
    key(buttons()[0], 'ArrowRight');
    expect(fixture.componentInstance.selected()).toBe('installed');
    expect(document.activeElement).toBe(buttons()[2]);
    expect(buttons().map((button) => button.tabIndex)).toEqual([-1, -1, 0, -1]);
    key(buttons()[2], 'End');
    expect(document.activeElement).toBe(buttons()[3]);
    key(buttons()[3], 'ArrowRight');
    expect(document.activeElement).toBe(buttons()[0]);
    key(buttons()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(buttons()[3]);
    key(buttons()[3], 'Home');
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it('falls back to an enabled tab when the selected panel is removed', () => {
    const { fixture, buttons } = render();
    fixture.componentInstance.selected.set('installed');
    fixture.detectChanges();
    fixture.componentInstance.installed.set(false);
    fixture.detectChanges();
    expect(buttons()[0].getAttribute('aria-selected')).toBe('true');
    expect(buttons().filter((button) => button.tabIndex === 0)).toHaveLength(1);
  });

  it('provides a labeled, focusable scroll region with a configurable height', () => {
    const { root } = render();
    const area = root.querySelector<HTMLElement>('pk-scroll-area')!;
    expect(area.getAttribute('role')).toBe('region');
    expect(area.getAttribute('aria-label')).toBe('Model results');
    expect(area.tabIndex).toBe(0);
    expect(area.style.maxHeight).toBe('20rem');
    expect(area.querySelector('button')?.textContent).toBe('A model');
  });
});
