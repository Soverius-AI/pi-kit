import { TestBed } from '@angular/core/testing';
import { UiStore } from '@pi-kit/data-access';
import { PreviewPrompt } from './preview-prompt';

describe('PreviewPrompt', () => {
  const preview = { op: 'set' as const, sourceUrl: 'http://localhost:3000' };

  beforeEach(() => localStorage.clear());
  afterEach(() => TestBed.resetTestingModule());

  async function ask() {
    const bus = TestBed.inject(UiStore);
    const fixture = TestBed.createComponent(PreviewPrompt);
    fixture.autoDetectChanges();
    bus.selectPreviewThread('t1');
    bus.setPreview('t1', preview, true);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const button = (label: string) =>
      [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
    return { bus, fixture, root, button };
  }

  it('asks once and opens the preview when the answer is always', async () => {
    const { bus, fixture, root, button } = await ask();
    expect(root.querySelector('[data-testid="preview-prompt"]')?.textContent).toContain('Open previews automatically');
    button('Always open').click();
    await fixture.whenStable();
    expect(bus.panel()).toBe('artifacts');
    expect(bus.previewAutoOpen()).toBe('always');
    expect(root.querySelector('[data-testid="preview-prompt"]')).toBeNull();
  });

  it('keeps asking after not now and stops after never', async () => {
    const { bus, fixture, button } = await ask();
    button('Not now').click();
    await fixture.whenStable();
    expect(bus.previewPrompt()).toBeUndefined();
    expect(bus.previewAutoOpen()).toBe('ask');
    bus.selectPreviewThread('t2');
    bus.setPreview('t2', preview, true);
    await fixture.whenStable();
    button('Never').click();
    await fixture.whenStable();
    expect(bus.previewAutoOpen()).toBe('never');
    expect(bus.panel()).toBeNull();
  });
});
