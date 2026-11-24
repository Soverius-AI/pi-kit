import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ApiClient, provideMockApi, projectFoldersList, type ProjectFolders } from '@pi-kit/api';
import { EnvironmentsStore } from '@pi-kit/data-access';
import { EnvironmentProjectPicker } from './environment-project-picker';

const home: ProjectFolders = {
  instanceId: 'host-a',
  directory: '/home',
  parent: '/',
  folders: [{ name: 'docs', path: '/home/docs' }],
};
describe('environment project folder browser', () => {
  function setup() {
    const list = vi.fn().mockResolvedValue(home);
    const forOwner = vi.fn();
    const picker = signal({ initialOwner: 'host-a', pick: vi.fn() });
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([[projectFoldersList, list, (options) => [options.query?.['directory'], options.signal]]]),
        {
          provide: EnvironmentsStore,
          useFactory: () => {
            forOwner.mockReturnValue(TestBed.inject(ApiClient).client);
            return {
              picker,
              groups: signal([
                { instanceId: 'host-a', name: 'First', projects: [] },
                { instanceId: 'host-b', name: 'Second', projects: [] },
              ]),
              manager: signal(undefined),
              api: { forOwner },
            };
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(EnvironmentProjectPicker);
    const root = fixture.nativeElement as HTMLElement;
    const item = (path: string) =>
      [...root.querySelectorAll<HTMLElement>('[role=treeitem]')].find((node) => node.dataset['path'] === path)!;
    return { fixture, root, item, list, forOwner, picker };
  }

  it('uses the shared expandable tree and keeps child requests scoped to the chosen environment', async () => {
    const { fixture, root, item, list, forOwner } = setup();
    list.mockImplementation(async (directory?: string) =>
      directory === '/home/docs'
        ? { ...home, directory, folders: [{ name: 'notes', path: '/home/docs/notes' }] }
        : home,
    );
    await fixture.whenStable();
    expect(root.querySelector('pk-folder-tree[data-testid=project-folders]')).not.toBeNull();
    item('/home/docs').click();
    await fixture.whenStable();
    await vi.waitFor(() => expect(item('/home/docs/notes')).toBeTruthy());
    expect(forOwner).toHaveBeenLastCalledWith('host-a');
    expect(list).toHaveBeenLastCalledWith('/home/docs', expect.any(AbortSignal));
    expect(root.querySelector('[data-testid=project-target]')?.textContent).toContain('/home/docs');
    item('/home/docs').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await fixture.whenStable();
    expect(root.querySelector<HTMLInputElement>('[data-testid=project-folder-path]')?.value).toBe('/home/docs');
  });

  it('aborts expanded reads on environment changes and does not render stale children from the previous owner', async () => {
    const { fixture, root, item, list, forOwner } = setup();
    await fixture.whenStable();
    let finish!: (value: ProjectFolders) => void;
    list.mockImplementationOnce(
      () =>
        new Promise<ProjectFolders>((resolve) => {
          finish = resolve;
        }),
    );
    item('/home/docs').click();
    await fixture.whenStable();
    const previousSignal = list.mock.calls.at(-1)![1] as AbortSignal;
    list.mockResolvedValue({ ...home, instanceId: 'host-b', folders: [{ name: 'server', path: '/home/server' }] });
    const owner = root.querySelector<HTMLSelectElement>('[data-testid=project-environment]')!;
    owner.value = 'host-b';
    owner.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    await vi.waitFor(() => expect(item('/home/server')).toBeTruthy());
    expect(previousSignal.aborted).toBe(true);
    expect(forOwner).toHaveBeenLastCalledWith('host-b');
    finish({ ...home, directory: '/home/docs', folders: [{ name: 'old secret', path: '/home/docs/secret' }] });
    await fixture.whenStable();
    expect(root.textContent).not.toContain('old secret');
    expect(root.querySelector('[data-testid=project-target]')?.textContent).toContain('/home');
  });

  it('rejects child listings whose canonical owner differs and allows the expansion to be retried', async () => {
    const { fixture, root, item, list } = setup();
    await fixture.whenStable();
    list.mockResolvedValueOnce({
      ...home,
      instanceId: 'another-host',
      folders: [{ name: 'untrusted', path: '/home/docs/untrusted' }],
    });
    item('/home/docs').click();
    await fixture.whenStable();
    expect(root.textContent).not.toContain('untrusted');
    expect(root.querySelector('[role=alert]')).not.toBeNull();
    expect(item('/home/docs').getAttribute('aria-expanded')).toBe('false');
    list.mockResolvedValueOnce({ ...home, directory: '/home/docs', folders: [] });
    item('/home/docs').click();
    await fixture.whenStable();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(item('/home/docs').getAttribute('aria-expanded')).toBe('true');
  });
});
