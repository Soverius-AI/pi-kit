import { TestBed } from '@angular/core/testing';
import { checkMcpFile, countServers } from '@pi-kit/protocol';
import { type EditorSource, FileEditorDialog } from './file-editor';

const GOOD = '{\n  "mcpServers": {\n    "a": { "url": "https://a.example/mcp" }\n  }\n}\n';

describe('FileEditorDialog', () => {
  let saved: { text: string; mtime: number }[];
  let load: ReturnType<typeof vi.fn>;
  let save: ReturnType<typeof vi.fn>;

  const source = (over: Partial<EditorSource> = {}): EditorSource => ({
    title: '~/.pi/agent/mcp.json',
    chips: [{ text: 'user', tone: 'off' }],
    language: 'json',
    load: load as never,
    save: save as never,
    check: (text) => {
      const first = checkMcpFile(text, 'user').problems[0];
      return first ? { line: first.line, message: first.message } : undefined;
    },
    valid: (text) => `Valid · ${countServers(text)} servers`,
    saveLabel: 'Save and reload',
    openExternally: vi.fn(),
    ...over,
  });

  const open = async (src: EditorSource = source()) => {
    const fixture = TestBed.createComponent(FileEditorDialog);
    fixture.componentRef.setInput('source', src);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  };
  const root = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(f: { nativeElement: unknown }, selector: string): T | null =>
    root(f).querySelector<T>(selector);
  const edit = (f: Awaited<ReturnType<typeof open>>, text: string): void => {
    const field = q<HTMLTextAreaElement>(f, 'textarea') as HTMLTextAreaElement;
    field.value = text;
    field.dispatchEvent(new Event('input'));
    f.detectChanges();
  };
  const saveButton = (f: Awaited<ReturnType<typeof open>>) =>
    q<HTMLButtonElement>(f, '[data-testid=editor-save]') as HTMLButtonElement;

  beforeEach(() => {
    saved = [];
    load = vi.fn(async () => ({ text: GOOD, mtime: Date.now() - 2 * 3_600_000 }));
    save = vi.fn(async (text: string, mtime: number) => {
      saved.push({ text, mtime });
      return { text, mtime: mtime + 1 };
    });
    TestBed.resetTestingModule();
  });

  it('loads the file, draws it with line numbers and colours, and says it is valid', async () => {
    const f = await open();
    expect(q(f, 'h2')?.textContent).toBe('~/.pi/agent/mcp.json');
    expect(q(f, '.head .chip')?.textContent).toBe('user');
    expect(q(f, '.head .muted')?.textContent).toBe('changed 2 h ago');
    expect(q<HTMLTextAreaElement>(f, 'textarea')?.value).toBe(GOOD);
    expect(Array.from(root(f).querySelectorAll('.ln span')).map((s) => s.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    expect(q(f, '.hl .k')?.textContent).toBe('"mcpServers"');
    expect(q(f, '[data-testid=editor-status]')?.textContent).toContain('Valid · 1 servers');
    expect(saveButton(f).disabled).toBe(true);
  });

  it('a change that breaks the file marks its line in the gutter, says why, and disables Save', async () => {
    const f = await open();
    edit(f, GOOD.replace('"url"', '"exposure": "codemod",\n    "url"'));
    expect(q(f, '[data-testid=editor-status]')?.getAttribute('data-valid')).toBe('no');
    expect(q(f, '[data-testid=editor-problem]')?.textContent).toBe(
      'Line 3: exposure must be one of codemode, deferred, direct, hidden.',
    );
    expect(q(f, '.ln span.err')?.textContent).toBe('3');
    expect(q(f, '.hl .err-line')).not.toBeNull();
    expect(saveButton(f).disabled).toBe(true);
    // fixing it enables Save again
    edit(f, GOOD.replace('"url"', '"exposure": "direct",\n    "url"'));
    expect(q(f, '.ln span.err')).toBeNull();
    expect(saveButton(f).disabled).toBe(false);
  });

  it('a syntax error is on its line too', async () => {
    const f = await open();
    edit(f, '{\n  "mcpServers": {\n    "a": { "url": "https://a.example/mcp" }\n    "b": {}\n  }\n}\n');
    expect(q(f, '[data-testid=editor-problem]')?.textContent).toMatch(/^Line 4: Expected "," or "}"/);
    expect(saveButton(f).disabled).toBe(true);
  });

  it('saves with the modified time it saw, and closes', async () => {
    const f = await open();
    const mtime = (await load.mock.results[0].value).mtime;
    let closed = 0;
    let savedEvents = 0;
    f.componentInstance.closed.subscribe(() => closed++);
    f.componentInstance.saved.subscribe(() => savedEvents++);
    const next = GOOD.replace('https://a.example/mcp', 'https://b.example/mcp');
    edit(f, next);
    saveButton(f).click();
    await f.whenStable();
    expect(saved).toEqual([{ text: next, mtime }]);
    expect(savedEvents).toBe(1);
    expect(closed).toBe(1);
  });

  it('⌘S in the editor saves; with the text invalid it does nothing', async () => {
    const f = await open();
    const next = GOOD.replace('https://a.example/mcp', 'https://c.example/mcp');
    edit(f, next);
    q(f, 'textarea')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }),
    );
    await f.whenStable();
    expect(saved).toHaveLength(1);
    const g = await open();
    edit(g, '{ nope');
    q(g, 'textarea')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await g.whenStable();
    expect(saved).toHaveLength(1);
  });

  it('a file that changed since is refused, and Reload reads it again', async () => {
    save.mockRejectedValueOnce(new Error('The file changed since you opened it. Reload and try again.'));
    const f = await open();
    edit(f, GOOD.replace('a.example', 'z.example'));
    saveButton(f).click();
    await f.whenStable();
    f.detectChanges();
    expect(q(f, '[data-testid=editor-error]')?.textContent).toContain('Reload and try again');
    expect(saveButton(f).disabled).toBe(true);
    const reload = q<HTMLButtonElement>(f, '[data-testid=editor-revert]') as HTMLButtonElement;
    expect(reload.textContent?.trim()).toBe('Reload');
    load.mockResolvedValueOnce({ text: GOOD.replace('a.example', 'other.example'), mtime: 5 });
    reload.click();
    await f.whenStable();
    f.detectChanges();
    expect(q<HTMLTextAreaElement>(f, 'textarea')?.value).toContain('other.example');
    expect(q(f, '[data-testid=editor-error]')).toBeNull();
    // the textarea was made again, and the caret is back in it: Escape must reach this dialog, not the page behind it
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(document.activeElement).toBe(q(f, 'textarea'));
  });

  it('closing with unsaved changes asks once; Keep editing stays, Discard closes', async () => {
    const f = await open();
    let closed = 0;
    f.componentInstance.closed.subscribe(() => closed++);
    q(f, '.win')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(1);

    const g = await open();
    g.componentInstance.closed.subscribe(() => closed++);
    edit(g, GOOD.replace('a.example', 'q.example'));
    q(g, '.win')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    g.detectChanges();
    expect(closed).toBe(1);
    expect(root(g).textContent).toContain('Discard your changes?');
    q(g, '[data-testid=keep-editing]')?.click();
    g.detectChanges();
    await g.whenStable();
    expect(root(g).textContent).not.toContain('Discard your changes?');
    expect(document.activeElement).toBe(q(g, 'textarea'));
    q(g, '.win')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    g.detectChanges();
    q(g, '[data-testid=discard]')?.click();
    expect(closed).toBe(2);
  });

  it('Revert puts the loaded text back; Open in editor is the host’s', async () => {
    const open_ = vi.fn();
    const f = await open(source({ openExternally: open_ }));
    edit(f, '{ "broken"');
    q(f, '[data-testid=editor-revert]')?.click();
    f.detectChanges();
    expect(q<HTMLTextAreaElement>(f, 'textarea')?.value).toBe(GOOD);
    const external = Array.from(root(f).querySelectorAll<HTMLButtonElement>('.foot button')).find(
      (b) => b.textContent?.trim() === 'Open in editor',
    );
    external?.click();
    expect(open_).toHaveBeenCalled();
  });

  it('a file that is not there yet opens empty, and a skill that was just created can be saved as it is', async () => {
    load.mockResolvedValueOnce({ text: '', mtime: 0, exists: false });
    const f = await open();
    expect(q<HTMLTextAreaElement>(f, 'textarea')?.value).toBe('');
    expect(q(f, '.head .muted')).toBeNull();
    const g = await open(source({ isNew: true, saveLabel: 'Save' }));
    expect(saveButton(g).disabled).toBe(false);
  });

  it('says why when the file cannot be read', async () => {
    load.mockRejectedValueOnce(new Error('That is not the file of one of your skills.'));
    const f = await open();
    expect(q(f, '[data-testid=editor-load-error]')?.textContent).toContain('not the file of one of your skills');
    expect(q(f, 'textarea')).toBeNull();
  });

  it('Enter keeps the indentation and goes one level in after a brace', async () => {
    const f = await open(source({ check: () => undefined }));
    const field = q<HTMLTextAreaElement>(f, 'textarea') as HTMLTextAreaElement;
    // jsdom has no execCommand: the editor falls back to setRangeText, which is what this exercises.
    field.value = '{\n  "a": {';
    field.dispatchEvent(new Event('input'));
    field.setSelectionRange(field.value.length, field.value.length);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    f.detectChanges();
    expect(field.value).toBe('{\n  "a": {\n    ');
  });
});
