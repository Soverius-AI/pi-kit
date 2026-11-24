import { TestBed } from '@angular/core/testing';
import { ApiClient, EntryApiClient, provideMockApi, projectFoldersList, type ProjectFolders } from '@pi-kit/api';
import { RoomFolderPicker } from './room-folder-picker';

const home: ProjectFolders = {
  instanceId: 'host-a',
  directory: '/home',
  parent: '/',
  folders: [
    { name: 'docs', path: '/home/docs' },
    { name: '.private', path: '/home/.private' },
  ],
};
describe('host folder picker', () => {
  function setup() {
    const list = vi.fn().mockResolvedValue(home);
    const forOwner = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([[projectFoldersList, list, (options) => [options.query?.['directory'], options.signal]]]),
        {
          provide: EntryApiClient,
          useFactory: () => {
            const api = TestBed.inject(ApiClient);
            forOwner.mockReturnValue(api.client);
            return { forOwner };
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(RoomFolderPicker);
    fixture.componentRef.setInput('owner', 'host-a');
    const root = fixture.nativeElement as HTMLElement;
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    const click = (id: string) => {
      root.querySelector<HTMLButtonElement>(`[data-testid=${id}]`)?.click();
    };
    return { fixture, root, list, forOwner, selected, click };
  }
  it('navigates direct children and parents on the selected host, filtering hidden folders locally', async () => {
    const { fixture, root, list, forOwner, selected, click } = setup();
    await fixture.whenStable();
    expect(forOwner).toHaveBeenCalledWith('host-a');
    expect(root.querySelector('[role=treeitem][data-path="/home/.private"]')).toBeNull();
    root.querySelector<HTMLInputElement>('[data-testid=room-folder-hidden]')?.click();
    await fixture.whenStable();
    expect(root.querySelector('[role=treeitem][data-path="/home/.private"]')).not.toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    list.mockImplementation(async (directory?: string) =>
      directory === '/home/docs'
        ? { ...home, directory: '/home/docs', parent: '/home', folders: [{ name: 'api', path: '/home/docs/api' }] }
        : directory === '/home/docs/api'
          ? { ...home, directory, folders: [] }
          : home,
    );
    root.querySelector<HTMLElement>('[role=treeitem][data-path="/home/docs"] > .pk-node')?.click();
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.querySelector('[role=treeitem][data-path="/home/docs/api"]')).not.toBeNull());
    root.querySelector<HTMLElement>('[role=treeitem][data-path="/home/docs/api"] > .pk-node')?.click();
    await fixture.whenStable();
    fixture.componentInstance.choose();
    expect(selected).toHaveBeenCalledExactlyOnceWith('/home/docs/api');
    expect(root.querySelector('[data-testid=room-folder-picker-target]')?.textContent).toBe('/home/docs/api');
    root
      .querySelector<HTMLElement>('[role=treeitem][data-path="/home/docs"] > .pk-node')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await fixture.whenStable();
    expect(list).toHaveBeenLastCalledWith('/home/docs', expect.any(AbortSignal));
    click('room-folder-up');
    await fixture.whenStable();
    expect(list).toHaveBeenLastCalledWith('/home', expect.any(AbortSignal));
  });
  it('requires navigation before selecting an edited path and never selects an old directory while loading', async () => {
    const { fixture, root, list, selected, click } = setup();
    await fixture.whenStable();
    const path = root.querySelector<HTMLInputElement>('[data-testid=room-folder-picker-path]')!;
    path.value = '/other';
    path.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(fixture.componentInstance.canSelect()).toBe(false);
    fixture.componentInstance.choose();
    expect(selected).not.toHaveBeenCalled();
    let finish: (result: ProjectFolders) => void = () => undefined;
    list.mockImplementationOnce(
      () =>
        new Promise<ProjectFolders>((resolve) => {
          finish = resolve;
        }),
    );
    click('room-folder-go');
    TestBed.tick();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(fixture.componentInstance.canSelect()).toBe(false);
    fixture.componentInstance.choose();
    expect(selected).not.toHaveBeenCalled();
    finish({ ...home, directory: '/canonical/other', folders: [] });
    await fixture.whenStable();
    expect(fixture.componentInstance.canSelect()).toBe(true);
    fixture.componentInstance.choose();
    expect(selected).toHaveBeenCalledExactlyOnceWith('/canonical/other');
  });
  it('retains the browse step on errors and supports retry', async () => {
    const { fixture, root, list, click } = setup();
    list.mockRejectedValueOnce(new Error('Folder access denied.'));
    await fixture.whenStable();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Folder access denied');
    expect(fixture.componentInstance.canSelect()).toBe(false);
    click('room-folder-picker-retry');
    await fixture.whenStable();
    expect(fixture.componentInstance.canSelect()).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('rejects a response belonging to a different owner', async () => {
    const { fixture, root, list, selected } = setup();
    list.mockResolvedValueOnce({ ...home, instanceId: 'wrong-host' });
    await fixture.whenStable();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('different host');
    expect(fixture.componentInstance.canSelect()).toBe(false);
    fixture.componentInstance.choose();
    expect(selected).not.toHaveBeenCalled();
  });
  it('aborts and ignores a late folder response when the room host changes', async () => {
    const { fixture, root, list, forOwner } = setup();
    let finish: (result: ProjectFolders) => void = () => undefined;
    list.mockImplementationOnce(
      () =>
        new Promise<ProjectFolders>((resolve) => {
          finish = resolve;
        }),
    );
    TestBed.tick();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const oldSignal = list.mock.calls[0][1] as AbortSignal;
    list.mockResolvedValue({
      ...home,
      instanceId: 'host-b',
      directory: '/new-host',
      folders: [{ name: 'New host docs', path: '/new-host/docs' }],
    });
    fixture.componentRef.setInput('owner', 'host-b');
    TestBed.tick();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);
    finish(home);
    await fixture.whenStable();
    expect(forOwner).toHaveBeenLastCalledWith('host-b');
    expect(root.textContent).toContain('New host docs');
    expect(root.querySelector('[role=treeitem][data-path="/home/docs"]')).toBeNull();
  });
  it('owner-checks nested folder loads and rejects child data from another host', async () => {
    const { fixture, root, list } = setup();
    await fixture.whenStable();
    list.mockResolvedValueOnce({
      ...home,
      instanceId: 'wrong-host',
      directory: '/home/docs',
      folders: [{ name: 'Wrong host secret', path: '/wrong/secret' }],
    });
    root.querySelector<HTMLElement>('[role=treeitem][data-path="/home/docs"] > .pk-node')?.click();
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.textContent).toContain('Could not load folders'));
    expect(root.querySelector('[role=treeitem][data-path="/wrong/secret"]')).toBeNull();
  });
});
