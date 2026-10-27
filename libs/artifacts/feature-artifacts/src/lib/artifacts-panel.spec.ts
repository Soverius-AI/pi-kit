import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserStore } from '@pi-kit/artifacts/data';
import { ChatStore } from '@pi-kit/chat/api';
import { emptyBrowserState } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';
import { ArtifactsPanel } from './artifacts-panel';

describe('browser artifact viewport', () => {
  const layout = vi.fn(async () => undefined);
  const page = signal({ ...emptyBrowserState('a', true), open: true, url: 'http://localhost:3000/' });
  const act = vi.fn(async () => undefined);
  beforeEach(() => {
    page.set({ ...emptyBrowserState('a', true), open: true, url: 'http://localhost:3000/' });
    act.mockClear();
    layout.mockClear();
    window.piKit = { getBackendUrl: async () => '', getToken: async () => '', setBrowserViewport: layout };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {
          /* layout is driven by the frame callback */
        }
        disconnect() {
          /* no native observer in jsdom */
        }
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: { selectedId: signal('a') } },
        { provide: ChatStore, useValue: { addImages: vi.fn() } },
      ],
    });
    TestBed.overrideComponent(ArtifactsPanel, {
      set: {
        providers: [
          {
            provide: BrowserStore,
            useValue: {
              page,
              threadId: signal('a'),
              busy: signal(false),
              error: signal(undefined),
              watch: vi.fn(),
              act,
            },
          },
        ],
      },
    });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    delete window.piKit;
    vi.unstubAllGlobals();
  });

  it('keeps an edited address and the native viewport stable across state polls', async () => {
    const fixture = TestBed.createComponent(ArtifactsPanel);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(layout).toHaveBeenCalledWith(expect.objectContaining({ bounds: expect.any(Object) })),
    );
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      '[aria-label="Browser address"]',
    );
    if (!input) throw new Error('Missing address field');
    input.value = 'http://localhost:4000/new-page';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    const before = layout.mock.calls.length;
    page.set({ ...page(), title: 'An updated page title' });
    await fixture.whenStable();
    expect(input.value).toBe('http://localhost:4000/new-page');
    expect(layout).toHaveBeenCalledTimes(before);
    (fixture.nativeElement as HTMLElement)
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(act).toHaveBeenCalledWith({ action: 'navigate', url: 'http://localhost:4000/new-page' });
    page.set({ ...page(), url: 'http://localhost:4000/new-page' });
    await fixture.whenStable();
    expect(input.value).toBe('http://localhost:4000/new-page');
  });

  it.each(['suspended', 'resizing'])(
    'detaches the native browser while %s and when the panel closes',
    async (input) => {
      const fixture = TestBed.createComponent(ArtifactsPanel);
      fixture.autoDetectChanges();
      await fixture.whenStable();
      await vi.waitFor(() =>
        expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'a', bounds: expect.any(Object) })),
      );
      fixture.componentRef.setInput(input, true);
      await fixture.whenStable();
      expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'a', bounds: null }));
      fixture.componentRef.setInput(input, false);
      await fixture.whenStable();
      await vi.waitFor(() =>
        expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ bounds: expect.any(Object) })),
      );
      fixture.destroy();
      expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ bounds: null }));
    },
  );
});
