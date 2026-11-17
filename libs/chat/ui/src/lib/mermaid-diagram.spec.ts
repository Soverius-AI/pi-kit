import { OverlayContainer } from '@angular/cdk/overlay';
import { Component, input, Pipe, PipeTransform, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ThemeStore } from '@pi-kit/data-access';
import { TranslocoPipe } from '@pi-kit/i18n';
import { CodeBlock } from './code-block';
import { MermaidDiagram } from './mermaid-diagram';
import { MermaidExport } from './mermaid-export';
import { MermaidViewer } from './mermaid-viewer';
import { MermaidRenderer } from './mermaid-renderer';

@Pipe({ name: 'transloco' })
class TestTranslation implements PipeTransform {
  transform(value: string) {
    return value;
  }
}
@Component({ selector: 'pk-code-block', template: '<pre>{{ code() }}</pre>' })
class TestCodeBlock {
  readonly code = input.required<string>();
  readonly language = input('');
}

const IMAGE = 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E';

describe('MermaidDiagram progressive rendering', () => {
  let fixture: ComponentFixture<MermaidDiagram>;
  let render: ReturnType<typeof vi.fn>;
  let download: ReturnType<typeof vi.fn>;
  let dark: ReturnType<typeof signal<boolean>>;
  const root = () => fixture.nativeElement as HTMLElement;
  async function update(source: string, streaming = true) {
    fixture.componentRef.setInput('source', source);
    fixture.componentRef.setInput('streaming', streaming);
    // Explicit detection is intentional here: whenStable would wait on the fake-clock
    // 180ms timer. Advance that clock before waiting for Angular's scheduled work.
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
  }
  async function advance() {
    await vi.advanceTimersByTimeAsync(180);
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    render = vi.fn().mockResolvedValue(IMAGE);
    download = vi.fn().mockResolvedValue(undefined);
    dark = signal(false);
    TestBed.configureTestingModule({
      providers: [
        { provide: MermaidRenderer, useValue: { render } },
        { provide: MermaidExport, useValue: { download } },
        { provide: ThemeStore, useValue: { isDark: dark } },
      ],
    });
    TestBed.overrideComponent(MermaidDiagram, {
      remove: { imports: [CodeBlock, TranslocoPipe] },
      add: { imports: [TestCodeBlock, TestTranslation] },
    });
    TestBed.overrideComponent(MermaidViewer, {
      remove: { imports: [TranslocoPipe] },
      add: { imports: [TestTranslation] },
    });
    fixture = TestBed.createComponent(MermaidDiagram);
  });
  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows a loader, then retries bounded valid line prefixes while streaming', async () => {
    render.mockImplementation((source: string) =>
      source.endsWith('B[') ? Promise.reject(new Error('incomplete')) : Promise.resolve(IMAGE),
    );
    await update('graph TD\nA-->B\nB[');
    expect(root().querySelector('[role="status"]')).not.toBeNull();
    await advance();
    expect(render.mock.calls.map((call) => call[0])).toEqual(['graph TD\nA-->B\nB[', 'graph TD\nA-->B']);
    expect(root().querySelector('img')?.getAttribute('src')).toBe(IMAGE);
    expect(root().querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps the last good image during partial failures but validates the exact final source', async () => {
    await update('graph TD\nA-->B');
    await advance();
    render.mockRejectedValue(new Error('Expected closing bracket'));
    await update('graph TD\nA-->B[');
    await advance();
    expect(root().querySelector('img')).not.toBeNull();
    expect(root().querySelector('[role="alert"]')).toBeNull();
    render.mockClear();
    await update('graph TD\nA-->B[', false);
    await Promise.resolve();
    fixture.detectChanges();
    expect(render).toHaveBeenCalledTimes(1);
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('Expected closing bracket');
    expect(root().querySelector('pre')?.textContent).toContain('A-->B[');
  });

  it('does not starve under continuous tokens and caps prefix retries', async () => {
    render.mockRejectedValue(new Error('partial'));
    await update('graph TD\n' + 'A[\n'.repeat(20));
    await vi.advanceTimersByTimeAsync(90);
    await update('graph TD\n' + 'B[\n'.repeat(20));
    await vi.advanceTimersByTimeAsync(90);
    expect(render).toHaveBeenCalledTimes(9);
  });

  it('ignores stale async completion and rerenders for theme changes', async () => {
    let resolveOld!: (image: string) => void;
    render.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await update('graph TD; old', false);
    await update('graph TD; new', false);
    await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(1); // Latest final request waits for backpressure.
    resolveOld('data:image/svg+xml,old');
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(root().querySelector('img')?.getAttribute('src')).toBe(IMAGE);
    dark.set(true);
    fixture.detectChanges();
    await Promise.resolve();
    expect(render).toHaveBeenLastCalledWith('graph TD; new', true, false);
  });

  it('publishes slow streaming results under continuous 90ms updates with only one render in flight', async () => {
    const completions: Array<(image: string) => void> = [];
    render.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          completions.push(resolve);
        }),
    );
    let source = 'graph TD; A';
    await update(source);
    await vi.advanceTimersByTimeAsync(180);
    expect(render).toHaveBeenCalledTimes(1);
    // The first render takes 450ms, while several newer snapshots become ready.
    for (let i = 0; i < 5; i++) {
      source += ' ';
      await update(source);
      await vi.advanceTimersByTimeAsync(90);
    }
    expect(render).toHaveBeenCalledTimes(1);
    completions[0](IMAGE);
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(root().querySelector('img')?.getAttribute('src')).toBe(IMAGE);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith(source, false, true);
    completions[1](IMAGE);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('invalidates a slow streaming completion when the source is replaced', async () => {
    let complete!: (image: string) => void;
    render.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    await update('graph TD; old');
    await advance();
    await update('graph TD; replacement');
    complete('data:image/svg+xml,obsolete');
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(root().querySelector('img')).toBeNull();
    await advance();
    expect(root().querySelector('img')?.getAttribute('src')).toBe(IMAGE);
  });

  it('invalidates an in-flight streaming result immediately on theme changes', async () => {
    let complete!: (image: string) => void;
    render.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    await update('graph TD; A');
    await advance();
    dark.set(true);
    fixture.detectChanges();
    complete('data:image/svg+xml,light');
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(root().querySelector('img')).toBeNull();
    await advance();
    expect(render).toHaveBeenLastCalledWith('graph TD; A', true, true);
    expect(root().querySelector('img')?.getAttribute('src')).toBe(IMAGE);
  });

  it('cleans up pending timers on destruction', async () => {
    await update('graph TD; A');
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(render).not.toHaveBeenCalled();
  });

  it('does not publish a completed render after destruction', async () => {
    let resolve!: (image: string) => void;
    render.mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    await update('graph TD; A', false);
    fixture.destroy();
    resolve(IMAGE);
    await Promise.resolve();
    expect(root().querySelector('img')).toBeNull();
  });

  it('disables fullscreen/download actions until a valid preview exists', async () => {
    await update('graph TD; A');
    expect(root().querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.disabled).toBe(true);
    expect(root().querySelector<HTMLButtonElement>('[aria-label="chat.markdown.downloadPng"]')?.disabled).toBe(true);
    await advance();
    expect(root().querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.disabled).toBe(false);
    expect(root().querySelector<HTMLButtonElement>('[aria-label="chat.markdown.downloadSvg"]')?.disabled).toBe(false);
  });

  it('opens an accessible fullscreen overlay with zoom/fit and closes on Escape', async () => {
    await update('graph TD; A', false);
    fixture.detectChanges();
    const trigger = root().querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    trigger.click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const overlays = TestBed.inject(OverlayContainer).getContainerElement();
    const dialog = overlays.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-label')).toBe('Fullscreen Mermaid diagram');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(IMAGE);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    dialog.querySelector<HTMLButtonElement>('[aria-label="chat.markdown.zoomIn"]')!.click();
    fixture.detectChanges();
    expect(dialog.querySelector<HTMLElement>('.pk-diagram-fullscreen-image')?.style.width).toBe('125%');
    dialog.querySelector<HTMLButtonElement>('[aria-label="chat.markdown.fitDiagram"]')!.click();
    fixture.detectChanges();
    expect(dialog.querySelector<HTMLElement>('.pk-diagram-fullscreen-image')?.style.width).toBe('100%');
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(overlays.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps an inspectable snapshot when the virtualized diagram is replaced', async () => {
    await update('graph TD; A', false);
    fixture.detectChanges();
    root().querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    const overlays = TestBed.inject(OverlayContainer).getContainerElement();
    expect(overlays.querySelector('[role="dialog"]')).not.toBeNull();
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(overlays.querySelector('[role="dialog"]')).not.toBeNull();
    expect(overlays.querySelector('.pk-diagram-snapshot')?.textContent).toContain('chat.markdown.snapshot');
    expect(overlays.querySelector('img')?.getAttribute('src')).toBe(IMAGE);
    overlays.querySelector<HTMLButtonElement>('[aria-label="chat.markdown.downloadSvg"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(download).toHaveBeenCalledWith(IMAGE, 'svg', expect.any(String));
    overlays.querySelector<HTMLButtonElement>('.pk-diagram-close')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(overlays.querySelector('[role="dialog"]')).toBeNull();
  });

  it('downloads the current preview as SVG and PNG and reports failures without breaking the diagram', async () => {
    await update('graph TD; A', false);
    fixture.detectChanges();
    root().querySelector<HTMLButtonElement>('[aria-label="chat.markdown.downloadSvg"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(download).toHaveBeenLastCalledWith(IMAGE, 'svg', expect.any(String));
    download.mockRejectedValueOnce(new Error('failed'));
    root().querySelector<HTMLButtonElement>('[aria-label="chat.markdown.downloadPng"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(download).toHaveBeenLastCalledWith(IMAGE, 'png', expect.any(String));
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('chat.markdown.downloadError');
    expect(root().querySelector('img')?.getAttribute('src')).toBe(IMAGE);
    root().querySelector<HTMLButtonElement>('[aria-label="chat.markdown.downloadSvg"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(root().querySelector('[role="alert"]')).toBeNull();
  });

  it('sizes the inline preview from the visible scroller above the composer and responds to resize', async () => {
    let resized!: ResizeObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resized = callback;
        }
        observe() {
          /* native scroller/overlay layout is mocked below */
        }
        disconnect = disconnect;
      },
    );
    const chat = document.createElement('copilot-chat-view');
    const scroller = document.createElement('div');
    scroller.setAttribute('cdkscrollable', '');
    const composer = document.createElement('copilot-chat-view-input-container');
    composer.innerHTML = '<div class="pk-composer"></div>';
    chat.append(scroller, composer);
    scroller.append(root());
    document.body.append(chat);
    let bottom = 550;
    let visibleComposer = true;
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 700 } as DOMRect);
    vi.spyOn(composer.firstElementChild!, 'getBoundingClientRect').mockImplementation(
      () => ({ top: bottom, bottom: 700, height: visibleComposer ? 700 - bottom : 0 }) as DOMRect,
    );
    await update('graph TD; A', false);
    fixture.detectChanges();
    expect(root().style.getPropertyValue('--pk-diagram-preview-height')).toBe('270px');
    bottom = 400;
    resized([], {} as ResizeObserver);
    fixture.detectChanges();
    expect(root().style.getPropertyValue('--pk-diagram-preview-height')).toBe('180px');
    visibleComposer = false;
    resized([], {} as ResizeObserver);
    fixture.detectChanges();
    expect(root().style.getPropertyValue('--pk-diagram-preview-height')).toBe('360px');
    fixture.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    chat.remove();
  });

  it('allows an accessible source toggle without rendering model HTML', async () => {
    await update('graph TD; A', false);
    await Promise.resolve();
    fixture.detectChanges();
    expect(root().querySelector('img')?.getAttribute('alt')).toBe('chat.markdown.diagramAlt');
    root().querySelectorAll<HTMLButtonElement>('button')[1].click();
    fixture.detectChanges();
    expect(root().querySelector('pre')?.textContent).toBe('graph TD; A');
    expect(root().querySelectorAll('button')[1].getAttribute('aria-pressed')).toBe('true');
  });
});
