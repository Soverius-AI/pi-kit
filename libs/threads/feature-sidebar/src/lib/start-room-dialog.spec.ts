import { TestBed } from '@angular/core/testing';
import { RoomsStore } from '@pi-kit/rooms/api';
import { CreateRoomSchema, type RoomStartPreview } from '@pi-kit/protocol';
import { StartRoomDialog } from './start-room-dialog';

describe('StartRoomDialog', () => {
  const start = vi.fn(async (_threadId: string, _ownerId?: string): Promise<RoomStartPreview> => ({
    title: 'Watcher',
    repository: 'github.com/acme/pi-kit',
    branch: 'main',
    baseCommit: 'b'.repeat(40),
    uncommittedFiles: 0,
  }));
  const create = vi.fn(async (input: { title: string }) => ({ id: 'r1', title: input.title }));
  const hosts = vi.fn(async () => [
    { environmentId: 'server', name: 'Server', local: true, ready: true, reason: null },
    { environmentId: 'desktop', name: 'Desktop', local: false, ready: true, reason: null },
  ]);

  let found: { folder: string; clean: boolean }[] = [{ folder: '/srv/pi-kit', clean: true }];
  const clones = vi.fn(async () => found);
  let books: {
    name: string;
    path: string;
    description: string;
    roles: string[];
    tools: string[];
    outputs: string[];
  }[] = [];
  const playbooks = vi.fn(async () => books);
  const askLead = vi.fn(async () => undefined);

  const render = async (ownerId: string) => {
    start.mockClear();
    create.mockClear();
    clones.mockClear();
    askLead.mockClear();
    TestBed.configureTestingModule({
      imports: [StartRoomDialog],
      providers: [{ provide: RoomsStore, useValue: { start, create, hosts, clones, playbooks, askLead } }],
    });
    const fixture = TestBed.createComponent(StartRoomDialog);
    fixture.componentRef.setInput('threadId', 't9');
    fixture.componentRef.setInput('threadTitle', 'Watcher');
    fixture.componentRef.setInput('ownerId', ownerId);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('reads a thread on Desktop there, hosts the room there by default and starts it from the thread', async () => {
    const el = await render('desktop');
    expect(start).toHaveBeenCalledWith('t9', 'desktop');
    expect((el.querySelector('[data-testid=start-room-host]') as HTMLSelectElement).value).toBe('desktop');
    expect(el.querySelector('[data-testid=start-room-host-note]')).toBeNull();
    (el.querySelector('[data-testid=start-room-create]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      { threadId: 't9', title: 'Watcher', summary: '' },
      expect.objectContaining({ environmentId: 'desktop' }),
    );
  });

  it('hosts a Desktop thread’s room on this computer from the repository and base commit', async () => {
    const el = await render('desktop');
    const select = el.querySelector('[data-testid=start-room-host]') as HTMLSelectElement;
    select.value = 'server';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(clones).toHaveBeenCalled());
    await Promise.resolve();
    TestBed.tick();
    expect(el.querySelector('[data-testid=start-room-folder-only]')?.textContent).toBe('/srv/pi-kit');
    (el.querySelector('[data-testid=start-room-create]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      {
        title: 'Watcher',
        summary: '',
        repository: 'github.com/acme/pi-kit',
        baseCommit: 'b'.repeat(40),
        projectFolder: '/srv/pi-kit',
      },
      expect.objectContaining({ environmentId: 'server' }),
    );
  });

  it('creates a personal room on another host from a non-Git thread without invalid repository fields', async () => {
    start.mockResolvedValueOnce({
      title: 'Watcher',
      repository: '',
      baseCommit: '',
      branch: null,
      uncommittedFiles: 0,
    });
    const el = await render('desktop');
    const host = el.querySelector('[data-testid=start-room-host]') as HTMLSelectElement;
    host.value = 'server';
    host.dispatchEvent(new Event('change'));
    TestBed.tick();
    await vi.waitFor(() =>
      expect((el.querySelector('[data-testid=start-room-create]') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(clones).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid=start-room-no-clone]')).toBeNull();
    (el.querySelector('[data-testid=start-room-create]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    const body = create.mock.calls[0]?.[0];
    expect(CreateRoomSchema.parse(body)).toEqual({ title: 'Watcher', summary: '' });
    expect(create).toHaveBeenCalledWith(
      { title: 'Watcher', summary: '' },
      expect.objectContaining({ environmentId: 'server' }),
    );
  });

  it('asks which folder when the chosen host has several clones, and blocks when it has none', async () => {
    found = [
      { folder: '/srv/pi-kit', clean: true },
      { folder: '/home/me/pi-kit', clean: false },
    ];
    const el = await render('desktop');
    const host = el.querySelector('[data-testid=start-room-host]') as HTMLSelectElement;
    host.value = 'server';
    host.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(clones).toHaveBeenCalledWith(
        'github.com/acme/pi-kit',
        'b'.repeat(40),
        expect.objectContaining({ environmentId: 'server' }),
      ),
    );
    await Promise.resolve();
    TestBed.tick();
    const folder = el.querySelector('[data-testid=start-room-folder-select]') as HTMLSelectElement;
    expect([...folder.options].map((option) => option.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '/srv/pi-kit',
      '/home/me/pi-kit · uncommitted changes',
    ]);
    folder.value = '/home/me/pi-kit';
    folder.dispatchEvent(new Event('change'));
    TestBed.tick();
    (el.querySelector('[data-testid=start-room-create]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ projectFolder: '/home/me/pi-kit' }),
      expect.anything(),
    );
    found = [];
    TestBed.resetTestingModule();
    const empty = await render('desktop');
    const again = empty.querySelector('[data-testid=start-room-host]') as HTMLSelectElement;
    again.value = 'server';
    again.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(clones).toHaveBeenCalled());
    await Promise.resolve();
    TestBed.tick();
    expect(empty.querySelector('[data-testid=start-room-no-clone]')).not.toBeNull();
    expect((empty.querySelector('[data-testid=start-room-create]') as HTMLButtonElement).disabled).toBe(true);
    found = [{ folder: '/srv/pi-kit', clean: true }];
  });

  describe('the playbook', () => {
    afterEach(() => (books = []));

    it('is offered even when the repository has none, with where they go and the lead to write one', async () => {
      const el = await render('server');
      const select = el.querySelector('[data-testid=start-room-playbook]') as HTMLSelectElement;
      expect(el.querySelector('[data-testid=start-room-playbook-hint]')?.textContent).toContain('.pi/skills');
      select.value = 'ask-lead';
      select.dispatchEvent(new Event('change'));
      (el.querySelector('[data-testid=start-room-create]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(askLead).toHaveBeenCalled());
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty('playbook');
      expect(askLead).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'r1' }),
        expect.stringContaining('room_playbook_guide'),
      );
    });

    it('starts the room with a playbook the repository has, and does not ask the lead', async () => {
      books = [{ name: 'triage', path: '/p/triage', description: 'Triage.', roles: [], tools: [], outputs: [] }];
      const el = await render('server');
      await vi.waitFor(() => {
        TestBed.tick();
        expect(el.querySelector('[data-testid=start-room-playbook] option[value=triage]')).not.toBeNull();
      });
      expect(el.querySelector('[data-testid=start-room-playbook-hint]')).toBeNull();
      const select = el.querySelector('[data-testid=start-room-playbook]') as HTMLSelectElement;
      select.value = 'triage';
      select.dispatchEvent(new Event('change'));
      (el.querySelector('[data-testid=start-room-create]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(create).toHaveBeenCalled());
      expect(create.mock.calls[0]?.[0]).toMatchObject({ playbook: 'triage' });
      expect(askLead).not.toHaveBeenCalled();
    });
  });
});
