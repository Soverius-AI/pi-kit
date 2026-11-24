import { TestBed } from '@angular/core/testing';
import { PkFolderTree, type PkFolderNode } from './folder-tree';

const roots: readonly PkFolderNode[] = [
  { name: 'alpha', path: '/root/alpha' },
  { name: 'beta', path: '/root/beta' },
  { name: '.hidden', path: '/root/.hidden' },
];
const nested: readonly PkFolderNode[] = [
  { name: 'child', path: '/root/alpha/child' },
  { name: '.secret', path: '/root/alpha/.secret' },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  load = vi.fn<(path: string, signal: AbortSignal) => Promise<readonly PkFolderNode[]>>().mockResolvedValue(nested),
) {
  const fixture = TestBed.createComponent(PkFolderTree);
  for (const [name, value] of Object.entries({
    folders: roots,
    scope: 'host-a:/root',
    label: 'Folders',
    emptyLabel: 'Empty',
    loadingLabel: 'Loading folders',
    errorLabel: 'Could not load folders',
    loadChildren: load,
  })) {
    fixture.componentRef.setInput(name, value);
  }
  const root = fixture.nativeElement as HTMLElement;
  const item = (path: string) =>
    [...root.querySelectorAll<HTMLElement>('[role=treeitem]')].find((row) => row.dataset['path'] === path)!;
  const key = (path: string, value: string) =>
    item(path).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  return { fixture, root, item, key, load };
}

describe('shared expandable folder tree', () => {
  it('lazily expands nested folders, reuses cached children and filters hidden entries at every level', async () => {
    const { fixture, root, item, load } = setup();
    const navigate = vi.fn();
    fixture.componentInstance.navigated.subscribe(navigate);
    await fixture.whenStable();
    expect(root.querySelector('[role=tree]')?.getAttribute('aria-label')).toBe('Folders');
    expect(root.querySelectorAll('[role=treeitem]')).toHaveLength(2);
    expect(item('/root/alpha').tabIndex).toBe(0);
    item('/root/alpha').click();
    await fixture.whenStable();
    expect(load).toHaveBeenCalledExactlyOnceWith('/root/alpha', expect.any(AbortSignal));
    expect(item('/root/alpha').getAttribute('aria-expanded')).toBe('true');
    expect(item('/root/alpha/child').closest('[role=group]')?.parentElement).toBe(item('/root/alpha'));
    expect(root.querySelectorAll('[role=treeitem]')).toHaveLength(3);
    item('/root/alpha/child').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toBe('/root/alpha/child');
    expect(root.querySelectorAll('[role=treeitem][data-path="/root/alpha/child"]')).toHaveLength(1);
    expect(item('/root/alpha').getAttribute('aria-expanded')).toBe('true');
    item('/root/alpha').click();
    await fixture.whenStable();
    expect(root.querySelectorAll('[role=treeitem]')).toHaveLength(2);
    item('/root/alpha').click();
    await fixture.whenStable();
    expect(load.mock.calls.filter(([path]) => path === '/root/alpha')).toHaveLength(1);
    fixture.componentRef.setInput('showHidden', true);
    await fixture.whenStable();
    expect(item('/root/.hidden')).toBeTruthy();
    expect(item('/root/alpha/.secret')).toBeTruthy();
    item('/root/alpha/child').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/root/alpha/child');
  });

  it('keeps one roving tab stop and navigates expanded rows with arrows, Home and End', async () => {
    const { fixture, root, item, key } = setup();
    await fixture.whenStable();
    item('/root/alpha').focus();
    key('/root/alpha', 'ArrowRight');
    await fixture.whenStable();
    key('/root/alpha', 'ArrowRight');
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toBe('/root/alpha/child');
    expect(root.querySelectorAll('[role=treeitem][tabindex="0"]')).toHaveLength(1);
    expect(document.activeElement).toBe(item('/root/alpha/child'));
    key('/root/alpha/child', 'ArrowLeft');
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toBe('/root/alpha');
    key('/root/alpha', 'ArrowLeft');
    await fixture.whenStable();
    expect(item('/root/alpha').getAttribute('aria-expanded')).toBe('false');
    key('/root/alpha', 'ArrowDown');
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toBe('/root/beta');
    key('/root/beta', 'Home');
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toBe('/root/alpha');
    key('/root/alpha', 'End');
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toBe('/root/beta');
    key('/root/beta', 'ArrowUp');
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toBe('/root/alpha');
    key('/root/alpha', 'Enter');
    await fixture.whenStable();
    expect(item('/root/alpha').getAttribute('aria-expanded')).toBe('true');
  });

  it('aborts previous scopes and ignores their late results even when the next host uses the same path', async () => {
    const old = deferred<readonly PkFolderNode[]>();
    const next = deferred<readonly PkFolderNode[]>();
    const load = vi
      .fn<(path: string, signal: AbortSignal) => Promise<readonly PkFolderNode[]>>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    const { fixture, root, item } = setup(load);
    await fixture.whenStable();
    item('/root/alpha').click();
    await fixture.whenStable();
    const firstSignal = load.mock.calls[0]![1];
    fixture.componentRef.setInput('scope', 'host-b:/root');
    await fixture.whenStable();
    expect(firstSignal.aborted).toBe(true);
    expect(item('/root/alpha').getAttribute('aria-expanded')).toBe('false');
    item('/root/alpha').click();
    await fixture.whenStable();
    old.resolve([{ name: 'Old host secret', path: '/root/alpha/old' }]);
    await fixture.whenStable();
    expect(root.textContent).not.toContain('Old host secret');
    expect(item('/root/alpha').getAttribute('aria-busy')).toBe('true');
    next.resolve([{ name: 'New host folder', path: '/root/alpha/new' }]);
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.textContent).toContain('New host folder'));
    expect(item('/root/alpha').getAttribute('aria-busy')).toBe('false');
  });

  it('deduplicates an in-flight expansion, makes failures retryable and aborts pending work on destroy', async () => {
    const first = deferred<readonly PkFolderNode[]>();
    const pending = deferred<readonly PkFolderNode[]>();
    const load = vi
      .fn<(path: string, signal: AbortSignal) => Promise<readonly PkFolderNode[]>>()
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('Denied'))
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pending.promise);
    const { fixture, root, item } = setup(load);
    await fixture.whenStable();
    item('/root/alpha').click();
    item('/root/alpha').click();
    item('/root/alpha').click();
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve(nested);
    await fixture.whenStable();
    item('/root/beta').click();
    await fixture.whenStable();
    expect(item('/root/beta').getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Could not load folders');
    item('/root/beta').click();
    await fixture.whenStable();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(item('/root/beta').textContent).toContain('Empty');
    item('/root/alpha/child').click();
    await fixture.whenStable();
    const signal = load.mock.calls[3]![1];
    fixture.destroy();
    expect(signal.aborted).toBe(true);
    pending.resolve([]);
    await Promise.resolve();
  });

  it('blocks selection, navigation and loads while disabled', async () => {
    const { fixture, root, item, key, load } = setup();
    const navigate = vi.fn();
    fixture.componentInstance.navigated.subscribe(navigate);
    fixture.componentRef.setInput('disabled', true);
    await fixture.whenStable();
    item('/root/alpha').click();
    item('/root/alpha').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    key('/root/alpha', 'ArrowRight');
    key('/root/alpha', 'End');
    expect(load).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.componentInstance.selected()).toBe('');
    expect(root.querySelector('[role=tree]')?.getAttribute('aria-disabled')).toBe('true');
    expect(root.querySelectorAll('[role=treeitem][tabindex="0"]')).toHaveLength(0);
  });
});
