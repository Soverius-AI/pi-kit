import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BackendService } from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/api';
import { UiStore } from '@pi-kit/data-access';
import { ThreadsStore } from '@pi-kit/threads/api';
import { IframePreviewPanel } from './iframe-preview-panel';
import { PreviewPolicy } from './preview-policy';

describe('iframe app preview', () => {
  const selectedId = signal('a');
  const addImages = vi.fn<(files: File[], options: { threadId: string; current: () => boolean }) => Promise<boolean>>(
    async () => true,
  );
  let meta: HTMLMetaElement;
  beforeEach(() => {
    selectedId.set('a');
    addImages.mockClear();
    meta = document.createElement('meta');
    meta.name = 'pi-kit-preview-origins';
    meta.content = JSON.stringify(['https://preview.example']);
    document.head.appendChild(meta);
    TestBed.configureTestingModule({
      providers: [
        { provide: BackendService, useValue: { url: async () => 'https://backend.example' } },
        { provide: ThreadsStore, useValue: { selectedId } },
        { provide: ChatStore, useValue: { addImages } },
      ],
    });
    const ui = TestBed.inject(UiStore);
    ui.selectPreviewThread('a');
  });
  afterEach(() => {
    meta.remove();
    TestBed.resetTestingModule();
  });

  async function draw(visible = true) {
    const fixture = TestBed.createComponent(IframePreviewPanel);
    fixture.componentRef.setInput('visible', visible);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => expect(TestBed.inject(PreviewPolicy).ready()).toBe(true));
    await fixture.whenStable();
    if (visible && TestBed.inject(UiStore).previewFor('a'))
      await vi.waitFor(() => expect(root.querySelector('iframe')).not.toBeNull());
    return { fixture, root, input: root.querySelector<HTMLInputElement>('input[type=url]')! };
  }
  const publish = (url: string) => TestBed.inject(UiStore).setPreview('a', { op: 'set', sourceUrl: url });
  function submit(root: HTMLElement, input: HTMLInputElement, url: string) {
    input.value = url;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }

  it('loads only after opening, uses an isolated sandbox and keeps the frame when hidden', async () => {
    publish('https://preview.example/app');
    const { fixture, root } = await draw(false);
    expect(root.querySelector('iframe')).toBeNull();
    fixture.componentRef.setInput('visible', true);
    await fixture.whenStable();
    const frame = root.querySelector('iframe')!;
    expect(frame.src).toBe('https://preview.example/app');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    fixture.componentRef.setInput('visible', false);
    await fixture.whenStable();
    expect(root.querySelector('iframe')).toBe(frame);
  });

  it('does not replace a working preview when the agent publishes a new URL', async () => {
    publish('https://preview.example/first');
    const { fixture, root, input } = await draw();
    const frame = root.querySelector('iframe');
    input.value = 'https://preview.example/unsaved';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    publish('https://preview.example/second');
    await fixture.whenStable();
    expect(root.querySelector('iframe')).toBe(frame);
    expect(input.value).toBe('https://preview.example/unsaved');
    const load = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Load new URL')!;
    load.click();
    await fixture.whenStable();
    expect(root.querySelector('iframe')?.src).toBe('https://preview.example/second');
  });

  it('refuses unapproved URLs but offers safe external opening', async () => {
    const { fixture, root, input } = await draw();
    submit(root, input, 'https://unapproved.example/app');
    await fixture.whenStable();
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.textContent).toContain('not approved');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://unapproved.example/app');
    submit(root, input, 'https://backend.example/api');
    await fixture.whenStable();
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('a')).toBeNull();
  });

  it('reloads explicitly, unloads without automatically recreating, and resets on thread change', async () => {
    publish('https://preview.example/app');
    const { fixture, root } = await draw();
    const find = (label: string) =>
      Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;
    const first = root.querySelector('iframe');
    find('Reload').click();
    await fixture.whenStable();
    expect(root.querySelector('iframe')).not.toBe(first);
    find('Unload preview').click();
    await fixture.whenStable();
    expect(root.querySelector('iframe')).toBeNull();
    fixture.componentRef.setInput('visible', false);
    await fixture.whenStable();
    fixture.componentRef.setInput('visible', true);
    await fixture.whenStable();
    expect(root.querySelector('iframe')).toBeNull();
    selectedId.set('b');
    await fixture.whenStable();
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('input[type=url]')?.value).toBe('');
  });

  it('attaches uploads only to the original current frame/thread and never sends a message', async () => {
    publish('https://preview.example/app');
    const { fixture, root } = await draw();
    const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = new File(['image'], 'screenshot.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await fixture.whenStable();
    expect(addImages).toHaveBeenCalledWith(
      [file],
      expect.objectContaining({ threadId: 'a', current: expect.any(Function) }),
    );
    const current = addImages.mock.calls[0][1].current;
    expect(current()).toBe(true);
    selectedId.set('b');
    await fixture.whenStable();
    expect(current()).toBe(false);
  });
});
