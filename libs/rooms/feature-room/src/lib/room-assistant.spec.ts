import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiClient, EntryApiClient, WORKBENCH, provideMockApi, projectFoldersList } from '@pi-kit/api';
import { OpenRoomStore, RoomAssistantStore } from '@pi-kit/rooms/data';
import type { RoomAssistantStatus, RoomMemoryEntry } from '@pi-kit/protocol';
import { RoomAssistant } from './room-assistant';

const initial: RoomAssistantStatus = {
  policy: { enabled: true, timezone: 'Europe/Vienna', quietStart: null, quietEnd: null, dailyLimit: 10 },
  memory: [{ key: 'working-hours', text: 'Prefer meetings after 10am.', updatedBy: 'owner-internal-id', updatedAt: 1 }],
  commitments: [],
  folders: [],
  workspace: '/room/workspace',
  work: [],
  files: [],
};

describe('compact room assistant', () => {
  function setup(value: RoomAssistantStatus = initial, entryId = 'host-a') {
    const store = {
      context: signal({ id: 'room-a', host: 'host-a' }),
      roomId: signal('room-a'),
      visible: signal(true),
      busy: signal(false),
      error: signal<string | undefined>(undefined),
      status: signal<RoomAssistantStatus>(structuredClone(value)),
      memory: vi.fn().mockResolvedValue(true),
      policy: vi.fn().mockResolvedValue(true),
      commitment: vi.fn().mockResolvedValue(true),
      updateCommitment: vi.fn().mockResolvedValue(true),
      folder: vi.fn().mockResolvedValue(true),
      removeFolder: vi.fn().mockResolvedValue(true),
      work: vi.fn().mockResolvedValue(true),
    };
    const memory = signal<RoomMemoryEntry[]>([]);
    const list = vi.fn().mockImplementation(async (directory?: string) => ({
      instanceId: store.context().host,
      directory: directory || '/host/home',
      parent: directory ? '/host/home' : '/host',
      folders:
        directory === '/host/home/research'
          ? []
          : [
              { name: 'research', path: '/host/home/research' },
              { name: '.hidden', path: '/host/home/.hidden' },
            ],
    }));
    const forOwner = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: RoomAssistantStore, useValue: store },
        ...provideMockApi([[projectFoldersList, list, (options) => [options.query?.['directory']]]]),
        {
          provide: EntryApiClient,
          useFactory: () => {
            const api = TestBed.inject(ApiClient);
            forOwner.mockReturnValue(api.client);
            return { forOwner };
          },
        },
        { provide: OpenRoomStore, useValue: { memory } },
        { provide: WORKBENCH, useValue: { entryId, remote: false } },
      ],
    });
    const fixture = TestBed.createComponent(RoomAssistant);
    const root = fixture.nativeElement as HTMLElement;
    const click = (id: string) => {
      const button = root.querySelector<HTMLButtonElement>(`[data-testid=${id}]`);
      if (!button) throw new Error(`Missing ${id}`);
      button.click();
    };
    const fill = async (id: string, value: string) => {
      const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid=${id}]`);
      if (!input) throw new Error(`Missing ${id}`);
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    const close = () => {
      const button = root.querySelector<HTMLButtonElement>('pk-room-dialog .pk-close');
      if (!button) throw new Error('Missing dialog close');
      button.click();
    };
    return { fixture, root, store, memory, list, forOwner, click, fill, close };
  }

  it('shows flat summaries without forms, nested details, internal memory keys or redundant explanations', async () => {
    const { fixture, root } = setup();
    await fixture.whenStable();
    expect(root.querySelector('input,textarea,select,details')).toBeNull();
    expect(root.querySelector('[data-testid=room-memory-item]')?.textContent).toContain('Prefer meetings after 10am.');
    expect(root.textContent).not.toContain('working-hours');
    expect(root.textContent).not.toContain('owner-internal-id');
    expect(root.textContent).not.toContain('No playbook is needed');
  });
  it('offers review but no manual memory creation, including an empty memory manager', async () => {
    const { fixture, root, click } = setup({ ...initial, memory: [] });
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-memory-add]')).toBeNull();
    click('room-memory-review');
    await fixture.whenStable();
    expect(root.textContent).toContain('Memory builds as you work.');
    expect(root.querySelector('input,textarea')).toBeNull();
    expect([...root.querySelectorAll('button')].some((button) => button.textContent?.includes('Add memory'))).toBe(
      false,
    );
  });
  it('edits a memory using its exact original hidden key and closes only after success', async () => {
    const { fixture, root, store, click, fill } = setup();
    await fixture.whenStable();
    click('room-memory-item');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-memory-key]')).toBeNull();
    await fill('room-memory-text', 'Prefer meetings after 11am.');
    click('room-memory-save');
    await fixture.whenStable();
    expect(store.memory).toHaveBeenCalledExactlyOnceWith({ key: 'working-hours', text: 'Prefer meetings after 11am.' });
    expect(root.querySelector('pk-room-dialog')).toBeNull();
  });
  it('reviews existing automatic memories and retains a failed correction until a successful retry', async () => {
    const { fixture, root, store, click, fill } = setup();
    store.memory.mockImplementationOnce(async () => {
      store.error.set('Could not save. Try again.');
      return false;
    });
    await fixture.whenStable();
    click('room-memory-item');
    await fixture.whenStable();
    await fill('room-memory-text', 'I prefer tea.');
    click('room-memory-save');
    await fixture.whenStable();
    expect(root.querySelector<HTMLTextAreaElement>('[data-testid=room-memory-text]')?.value).toBe('I prefer tea.');
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Could not save');
    const sent = store.memory.mock.calls[0][0];
    expect(sent).toEqual({ key: 'working-hours', text: 'I prefer tea.' });
    click('room-memory-save');
    await fixture.whenStable();
    expect(store.memory.mock.calls[1][0].key).toBe(sent.key);
    expect(root.querySelector('pk-room-dialog')).toBeNull();
  });
  it('does not let a completed old save close a new dialog after Cancel and reopen', async () => {
    const { fixture, root, store, click, fill, close } = setup();
    let finish: (value: boolean) => void = () => undefined;
    store.memory.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await fixture.whenStable();
    click('room-memory-item');
    await fixture.whenStable();
    await fill('room-memory-text', 'Old draft');
    click('room-memory-save');
    await fixture.whenStable();
    close();
    await fixture.whenStable();
    click('room-memory-item');
    await fixture.whenStable();
    await fill('room-memory-text', 'New draft');
    finish(true);
    await fixture.whenStable();
    expect(root.querySelector<HTMLTextAreaElement>('[data-testid=room-memory-text]')?.value).toBe('New draft');
  });
  it('closes and clears drafts on host changes even when the room id stays the same', async () => {
    const { fixture, root, store, click, fill } = setup();
    await fixture.whenStable();
    click('room-memory-item');
    await fixture.whenStable();
    await fill('room-memory-text', 'Private old host');
    store.context.set({ id: 'room-a', host: 'host-b' });
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    click('room-memory-item');
    await fixture.whenStable();
    expect(root.querySelector<HTMLTextAreaElement>('[data-testid=room-memory-text]')?.value).toBe(
      'Prefer meetings after 10am.',
    );
  });
  it('keeps playbook memories read-only and offers explicit confirmation before forgetting room memory', async () => {
    const { fixture, root, store, memory, click } = setup();
    memory.set([
      {
        key: 'playbook-private-key',
        text: 'Keep summaries short.',
        scope: 'playbook',
        updatedBy: 'lead',
        updatedAt: 1,
      },
    ]);
    await fixture.whenStable();
    click('room-playbook-memory-item');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-playbook-memory]')?.textContent).toContain('Keep summaries short.');
    expect(root.querySelector('[data-testid=room-playbook-memory] button')).toBeNull();
    expect(root.textContent).not.toContain('playbook-private-key');
    root.querySelector<HTMLButtonElement>('[data-testid=room-memory-entry]')?.click();
    await fixture.whenStable();
    click('room-memory-forget');
    await fixture.whenStable();
    expect(store.memory).not.toHaveBeenCalled();
    click('room-memory-forget-confirm');
    await fixture.whenStable();
    expect(store.memory).toHaveBeenCalledWith({ key: 'working-hours', text: '' });
  });
  it('preserves unlimited legacy run policy when saving other settings', async () => {
    const { fixture, root, store, click } = setup();
    await fixture.whenStable();
    click('room-proactive-settings');
    await fixture.whenStable();
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-policy-limit-runs]')?.checked).toBe(false);
    expect(root.querySelector('[data-testid=room-policy-run-limit]')).toBeNull();
    click('room-policy-save');
    await fixture.whenStable();
    expect(store.policy).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, dailyRunLimit: undefined }));
  });
  it('uses proactive mode as the master toggle for all dependent settings and disables everything while busy', async () => {
    const { fixture, root, store, click } = setup({
      ...initial,
      policy: { ...initial.policy, enabled: false, dailyRunLimit: 8 },
    });
    await fixture.whenStable();
    click('room-proactive-settings');
    await fixture.whenStable();
    const master = root.querySelector<HTMLInputElement>('[data-testid=room-policy-enabled]')!;
    const dependent = [...root.querySelectorAll<HTMLInputElement>('#room-policy-form input')].filter(
      (input) => input !== master,
    );
    expect(dependent).toHaveLength(6);
    expect(dependent.every((input) => input.disabled)).toBe(true);
    expect(master.disabled).toBe(false);
    master.click();
    await fixture.whenStable();
    expect(master.checked).toBe(true);
    expect(dependent.every((input) => !input.disabled)).toBe(true);
    store.busy.set(true);
    await fixture.whenStable();
    expect(
      [...root.querySelectorAll<HTMLInputElement>('#room-policy-form input')].every((input) => input.disabled),
    ).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-testid=room-policy-save]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('pk-room-dialog .pk-close')?.disabled).toBe(false);
  });
  it('can turn proactive mode off after invalid draft edits while preserving every stored setting', async () => {
    const stored = { ...initial.policy, quietStart: '22:00', quietEnd: '08:00', dailyRunLimit: 8 };
    const { fixture, root, store, click, fill } = setup({ ...initial, policy: stored });
    await fixture.whenStable();
    click('room-proactive-settings');
    await fixture.whenStable();
    await fill('room-policy-timezone', '');
    await fill('room-policy-daily-limit', '0');
    await fill('room-policy-run-limit', '0');
    expect(root.querySelector<HTMLButtonElement>('[data-testid=room-policy-save]')?.disabled).toBe(true);
    root.querySelector<HTMLInputElement>('[data-testid=room-policy-enabled]')?.click();
    await fixture.whenStable();
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-policy-timezone]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-testid=room-policy-save]')?.disabled).toBe(false);
    click('room-policy-save');
    await fixture.whenStable();
    expect(store.policy).toHaveBeenCalledExactlyOnceWith({ ...stored, enabled: false });
    expect(root.querySelector('pk-room-dialog')).toBeNull();
  });
  it('keeps an unlimited legacy run limit absent when turning proactive mode off', async () => {
    const { fixture, root, store, click, fill } = setup();
    await fixture.whenStable();
    click('room-proactive-settings');
    await fixture.whenStable();
    await fill('room-policy-timezone', '');
    root.querySelector<HTMLInputElement>('[data-testid=room-policy-enabled]')?.click();
    await fixture.whenStable();
    click('room-policy-save');
    await fixture.whenStable();
    expect(store.policy).toHaveBeenCalledExactlyOnceWith({ ...initial.policy, enabled: false });
    expect(store.policy.mock.calls[0][0]).not.toHaveProperty('dailyRunLimit');
  });
  it('adds a validated folder in a dialog and requires confirmation before removing a link', async () => {
    const linked = {
      id: 'folder-id',
      alias: 'research',
      target: '/data/research',
      canonical: '/data/research',
      environmentId: 'host-a',
      access: 'read' as const,
      available: true,
      reason: null,
    };
    const { fixture, root, store, click, fill } = setup({ ...initial, folders: [linked] });
    await fixture.whenStable();
    click('room-folder-add');
    await fixture.whenStable();
    await fill('room-folder-alias', 'bad name');
    await fill('room-folder-target', '/data/docs');
    expect(root.querySelector<HTMLButtonElement>('[data-testid=room-folder-save]')?.disabled).toBe(true);
    await fill('room-folder-alias', 'docs');
    click('room-folder-save');
    await fixture.whenStable();
    expect(store.folder).toHaveBeenCalledExactlyOnceWith({ alias: 'docs', target: '/data/docs' });
    click('room-folder-add');
    await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('pk-room-dialog .pk-close')?.click();
    await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('[data-folder=folder-id]')?.click();
    await fixture.whenStable();
    click('room-folder-remove');
    await fixture.whenStable();
    expect(store.removeFolder).not.toHaveBeenCalled();
    click('room-folder-remove-confirm');
    await fixture.whenStable();
    expect(store.removeFolder).toHaveBeenCalledExactlyOnceWith('folder-id');
  });
  it('offers the native picker only for the locally executing room host and ignores a late pick after changing hosts', async () => {
    const bridge = window.piKit;
    let finish: (value: string) => void = () => undefined;
    window.piKit = {
      getBackendUrl: async () => 'http://localhost:4300',
      showOpenDialog: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    try {
      const { fixture, root, store, click } = setup();
      await fixture.whenStable();
      click('room-folder-add');
      await fixture.whenStable();
      expect(root.querySelector('[data-testid=room-folder-browse]')).not.toBeNull();
      click('room-folder-browse');
      await fixture.whenStable();
      store.context.set({ id: 'room-a', host: 'remote-host' });
      await fixture.whenStable();
      click('room-folder-add');
      await fixture.whenStable();
      expect(root.querySelector('[data-testid=room-folder-browse]')).not.toBeNull();
      finish('/private/local-only');
      await fixture.whenStable();
      expect(root.querySelector<HTMLInputElement>('[data-testid=room-folder-target]')?.value).toBe('');
    } finally {
      window.piKit = bridge;
    }
  });
  it('browses folders on a remote room host and selects without linking until explicit Save', async () => {
    const { fixture, root, store, list, forOwner, click, fill } = setup();
    store.context.set({ id: 'room-a', host: 'remote-host' });
    await fixture.whenStable();
    click('room-folder-add');
    await fixture.whenStable();
    await fill('room-folder-alias', 'my-notes');
    const pathControl = root.querySelector('[data-testid=room-folder-path-control]');
    expect(pathControl?.querySelector('[data-testid=room-folder-target]')).not.toBeNull();
    expect(pathControl?.querySelector('[data-testid=room-folder-browse]')).not.toBeNull();
    expect(root.querySelector('label[for=room-folder-target-input]')).not.toBeNull();
    click('room-folder-browse');
    await fixture.whenStable();
    expect(root.querySelectorAll('[role=dialog]')).toHaveLength(1);
    expect(root.querySelector('[data-testid=room-folder-picker]')).not.toBeNull();
    expect(forOwner).toHaveBeenCalledWith('remote-host');
    expect(list).toHaveBeenCalledWith(undefined);
    root.querySelector<HTMLButtonElement>('[role=treeitem][data-path="/host/home/research"] > .pk-node')?.click();
    await fixture.whenStable();
    click('room-folder-picker-select');
    await fixture.whenStable();
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-folder-target]')?.value).toBe('/host/home/research');
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-folder-alias]')?.value).toBe('my-notes');
    expect(store.folder).not.toHaveBeenCalled();
    click('room-folder-save');
    await fixture.whenStable();
    expect(store.folder).toHaveBeenCalledExactlyOnceWith({ alias: 'my-notes', target: '/host/home/research' });
  });
  it('keeps the typed folder draft when cancelling the browse step', async () => {
    const { fixture, root, click, fill } = setup();
    await fixture.whenStable();
    click('room-folder-add');
    await fixture.whenStable();
    await fill('room-folder-alias', 'draft');
    await fill('room-folder-target', '/draft/path');
    click('room-folder-browse');
    await fixture.whenStable();
    click('room-dialog-close');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-folder-picker]')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-folder-target]')?.value).toBe('/draft/path');
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-folder-alias]')?.value).toBe('draft');
  });
  it('creates timezone-aware reminders and keeps safe review actions in the activity manager', async () => {
    const { fixture, root, store, click, fill } = setup({
      ...initial,
      work: [{ id: 'work-id', title: 'Update calendar', state: 'review', kind: 'owner', createdAt: 1 }],
    });
    await fixture.whenStable();
    click('room-reminder-add');
    await fixture.whenStable();
    await fill('room-commitment-title', 'Prepare notes');
    await fill('room-commitment-due', '2026-11-25T09:00');
    click('room-reminder-save');
    await fixture.whenStable();
    expect(store.commitment).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Prepare notes',
        dueAt: Date.parse('2026-11-25T08:00:00Z'),
        timezone: 'Europe/Vienna',
      }),
    );
    click('room-work-manager');
    await fixture.whenStable();
    expect(root.textContent).toContain('previous attempt may already have changed connected apps');
    const retry = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Retry after review'),
    );
    retry?.click();
    expect(store.work).toHaveBeenCalledWith('work-id', true);
  });
});
