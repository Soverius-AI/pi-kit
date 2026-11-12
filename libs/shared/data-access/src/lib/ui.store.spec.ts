import { TestBed } from '@angular/core/testing';
import { UiStore } from './ui.store';

describe('UiStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
    vi.stubGlobal('innerWidth', 1600);
  });
  afterEach(() => vi.unstubAllGlobals());

  const preview = { op: 'set' as const, sourceUrl: 'http://localhost:3000', title: 'App' };

  it('asks before opening the first live publication instead of covering the chat', () => {
    const ui = TestBed.inject(UiStore);
    vi.stubGlobal('innerWidth', 900);
    ui.selectPreviewThread('t1');
    ui.browserActivity('t1');
    expect(ui.hasPreview('t1')).toBe(true);
    expect(ui.previewFor('t1')).toBeUndefined();
    ui.setPreview('t1', preview, true);
    expect(ui.panel()).toBeNull();
    expect(ui.previewPrompt()).toBe('t1');
    ui.dismissPreviewPrompt();
    ui.setPreview('t1', preview, true);
    expect(ui.previewPrompt()).toBeUndefined();
    expect(ui.previewAutoOpen()).toBe('ask');
  });

  it('opens at once and from then on when the answer is always, on every width', () => {
    let ui = TestBed.inject(UiStore);
    vi.stubGlobal('innerWidth', 400);
    ui.selectPreviewThread('t1');
    ui.setPreview('t1', preview, true);
    ui.setPreviewAutoOpen('always');
    expect(ui.panel()).toBe('artifacts');
    expect(ui.previewPrompt()).toBeUndefined();
    TestBed.resetTestingModule();
    ui = TestBed.inject(UiStore);
    expect(ui.previewAutoOpen()).toBe('always');
    ui.selectPreviewThread('t2');
    ui.setPreview('t2', preview, true);
    expect(ui.panel()).toBe('artifacts');
  });

  it('never asks or opens again once the answer is never', () => {
    let ui = TestBed.inject(UiStore);
    ui.selectPreviewThread('t1');
    ui.setPreview('t1', preview, true);
    ui.setPreviewAutoOpen('never');
    expect(ui.panel()).toBeNull();
    expect(ui.previewPrompt()).toBeUndefined();
    TestBed.resetTestingModule();
    ui = TestBed.inject(UiStore);
    ui.selectPreviewThread('t2');
    ui.setPreview('t2', preview, true);
    expect(ui.panel()).toBeNull();
    expect(ui.previewPrompt()).toBeUndefined();
  });

  it('drops a pending question when the preview opens or the chat changes', () => {
    const ui = TestBed.inject(UiStore);
    ui.selectPreviewThread('t1');
    ui.setPreview('t1', preview, true);
    ui.setPanel('artifacts');
    expect(ui.previewPrompt()).toBeUndefined();
    ui.selectPreviewThread('t2');
    ui.setPreview('t2', preview, true);
    expect(ui.previewPrompt()).toBe('t2');
    ui.selectPreviewThread('t3');
    expect(ui.previewPrompt()).toBeUndefined();
    ui.setPreviewAutoOpen('always');
    expect(ui.panel()).toBeNull();
  });

  it('a hydrated thread without a preview still opens its first live publication', () => {
    const ui = TestBed.inject(UiStore);
    ui.setPreviewAutoOpen('always');
    ui.selectPreviewThread('t1');
    ui.setPreview('t1', { op: 'clear' }, false);
    ui.setPreview('t1', preview, true);
    expect(ui.panel()).toBe('artifacts');
  });

  it('only the first fresh publication opens and never steals another panel', () => {
    const ui = TestBed.inject(UiStore);
    ui.setPreviewAutoOpen('always');
    ui.selectPreviewThread('t1');
    ui.setPanel('files');
    ui.setPreview('t1', preview, true);
    expect(ui.panel()).toBe('files');
    expect(ui.previewPrompt()).toBeUndefined();
    ui.closePanel();
    ui.setPreview('t1', preview, true);
    expect(ui.panel()).toBeNull();
    ui.selectPreviewThread('t2');
    ui.setPreview('t2', preview, true);
    expect(ui.panel()).toBe('artifacts');
  });

  it('an explicit clear removes native activity and metadata only for its scope/thread', () => {
    const ui = TestBed.inject(UiStore);
    ui.selectPreviewThread('t1', 'owner-a');
    ui.browserActivity('t1');
    ui.browserActivity('t2');
    ui.setPreview('t1', preview);
    ui.selectPreviewThread('t1', 'owner-b');
    ui.browserActivity('t1');
    ui.selectPreviewThread('t1', 'owner-a');
    ui.setPreview('t1', { op: 'clear' });
    expect(ui.previewFor('t1')).toBeUndefined();
    expect(ui.hasPreview('t1')).toBe(false);
    expect(ui.hasPreview('t2')).toBe(true);
    ui.selectPreviewThread('t1', 'owner-b');
    expect(ui.hasPreview('t1')).toBe(true);
  });

  it('hydration and reconnect publications do not open or become fresh later', () => {
    const ui = TestBed.inject(UiStore);
    ui.selectPreviewThread('t1');
    ui.setPreview('t1', preview);
    ui.setPreview('t1', preview, false);
    ui.setPreview('t1', preview, true);
    expect(ui.previewFor('t1')).toEqual({ sourceUrl: preview.sourceUrl, title: 'App' });
    expect(ui.panel()).toBeNull();
    expect(ui.previewPrompt()).toBeUndefined();
    ui.setPreview('t1', { op: 'clear' });
    expect(ui.hasPreview('t1')).toBe(false);
  });

  it.each(['close', 'toggle', 'replace', 'set-null', 'overlay', 'files-filter'])(
    'persists dismissal through %s while explicit opening still works',
    (exit) => {
      let ui = TestBed.inject(UiStore);
      ui.setPreviewAutoOpen('always');
      ui.selectPreviewThread('t1', 'owner');
      ui.setPreview('t1', preview, true);
      if (exit === 'close') ui.closePanel();
      if (exit === 'toggle') ui.togglePanel('artifacts');
      if (exit === 'replace') ui.togglePanel('tree');
      if (exit === 'set-null') ui.setPanel(null);
      if (exit === 'overlay') {
        vi.stubGlobal('innerWidth', 900);
        ui.closePanelIfOverlay();
      }
      if (exit === 'files-filter') ui.focusFilesFilter();
      TestBed.resetTestingModule();
      vi.stubGlobal('innerWidth', 1600);
      ui = TestBed.inject(UiStore);
      ui.selectPreviewThread('t1', 'owner');
      ui.setPreview('t1', preview, true);
      expect(ui.panel()).toBeNull();
      ui.setPanel('artifacts');
      expect(ui.panel()).toBe('artifacts');
    },
  );

  it('isolates scopes and threads and starts narrow thread switches in chat', () => {
    const ui = TestBed.inject(UiStore);
    ui.setPreviewAutoOpen('always');
    ui.selectPreviewThread('t1', 'owner-a');
    ui.setPreview('t1', preview, true);
    ui.closePanel();
    ui.selectPreviewThread('t1', 'owner-b');
    expect(ui.hasPreview('t1')).toBe(false);
    ui.setPreview('t1', preview, true);
    expect(ui.panel()).toBe('artifacts');
    vi.stubGlobal('innerWidth', 900);
    ui.selectPreviewThread('t2', 'owner-b');
    expect(ui.panel()).toBeNull();
    ui.setPanel('files');
    ui.selectPreviewThread('t1', 'owner-b');
    expect(ui.panel()).toBeNull();
    expect(ui.hasPreview('t2')).toBe(false);
  });

  it('toggles a side panel and closes it', () => {
    const ui = TestBed.inject(UiStore);
    ui.togglePanel('tree');
    expect(ui.panel()).toBe('tree');
    ui.togglePanel('files');
    expect(ui.panel()).toBe('files');
    ui.togglePanel('files');
    expect(ui.panel()).toBeNull();
  });

  it('closePanelIfOverlay closes only below the overlay width', () => {
    const ui = TestBed.inject(UiStore);
    ui.setPanel('changes');
    vi.stubGlobal('innerWidth', 1600);
    expect(ui.closePanelIfOverlay()).toBe(false);
    expect(ui.panel()).toBe('changes');
    vi.stubGlobal('innerWidth', 1200);
    expect(ui.closePanelIfOverlay()).toBe(true);
    expect(ui.panel()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('the Files filter shortcut opens the panel and bumps the request', () => {
    const ui = TestBed.inject(UiStore);
    ui.focusFilesFilter();
    ui.focusFilesFilter();
    expect(ui.panel()).toBe('files');
    expect(ui.filesFilter()).toBe(2);
  });

  it('opens settings on a tab, with a sign-in, and /mcp opens the MCP section', () => {
    const ui = TestBed.inject(UiStore);
    ui.openSettings('providers', 'anthropic');
    expect(ui.settings()).toEqual({ tab: 'providers', login: 'anthropic' });
    ui.openMcpPanel();
    expect(ui.settings()?.tab).toBe('mcp');
    ui.closeSettings();
    expect(ui.settings()).toBeNull();
  });

  it('requests to the composer make equal texts distinct', () => {
    const ui = TestBed.inject(UiStore);
    ui.setComposerText('hello');
    const first = ui.composerText();
    ui.setComposerText('hello');
    expect(ui.composerText()).not.toEqual(first);
    ui.insertIntoComposer('@a.ts');
    expect(ui.composerInsert()).toEqual({ text: '@a.ts', n: 1 });
    ui.openChipMenu('model');
    ui.openChipMenu('model');
    expect(ui.chipMenu()?.n).toBe(2);
  });

  it('palette and tree-stale', () => {
    const ui = TestBed.inject(UiStore);
    ui.togglePalette();
    expect(ui.palette()).toBe(true);
    ui.closePalette();
    expect(ui.palette()).toBe(false);
    ui.markTreeStale();
    expect(ui.treeStale()).toBe(1);
  });
});
