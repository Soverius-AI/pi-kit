import { TestBed } from '@angular/core/testing';
import { UiStore } from './ui.store';

describe('UiStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

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
