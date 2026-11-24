import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiClient, EntryApiClient, provideMockApi, roomsAddAgent, roomsRemoveAgent } from '@pi-kit/api';
import type { A2aAgent, RoomParticipants, RoomParticipantTargets } from '@pi-kit/protocol';
import { OpenRoomStore, RoomAgentsStore } from '@pi-kit/rooms/data';
import { RoomAgents } from './room-agents';

const targets: RoomParticipantTargets = {
  machines: [
    {
      environmentId: 'local-host',
      name: 'Room host',
      local: true,
      ready: true,
      reason: null,
      look: { icon: 'runner', color: 2 },
    },
    {
      environmentId: 'paired-host',
      name: 'Paired machine',
      local: false,
      ready: true,
      reason: null,
      look: { icon: 'neko', color: 7 },
    },
    {
      environmentId: 'offline-host',
      name: 'Offline machine',
      local: false,
      ready: false,
      reason: 'Machine is offline.',
    },
  ],
  agents: [
    {
      id: 'external-id',
      name: 'External researcher',
      url: 'https://agent.example.test',
      tokenStorage: 'none',
      createdAt: 1,
    },
  ],
};
const registered: A2aAgent = {
  id: 'new-external-id',
  name: 'New specialist',
  url: 'https://new.example.test',
  tokenStorage: 'keychain',
  createdAt: 1,
};

describe('room agent setup', () => {
  function setup(members: RoomParticipants['members'] = []) {
    const store = {
      context: signal({ id: 'room-a', host: 'local-host' }),
      visible: signal(false),
      targetsVisible: signal(false),
      status: signal<RoomParticipants>({ members }),
      targets: signal<RoomParticipantTargets>(structuredClone(targets)),
      models: signal([
        { provider: 'provider', id: 'model', name: 'Available model', available: true, reasoning: false },
      ]),
      modelsError: signal<string | undefined>(undefined),
      modelsLoading: signal(false),
      showModels: vi.fn(),
      retryModels: vi.fn(),
      busy: signal(false),
      error: signal<string | undefined>(undefined),
      targetsError: signal<string | undefined>(undefined),
      add: vi.fn().mockResolvedValue(true),
      update: vi.fn().mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(true),
      refresh: vi.fn(),
      refreshTargets: vi.fn(),
    };
    const register = vi.fn().mockResolvedValue(registered);
    const globalRemove = vi.fn();
    const forOwner = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: OpenRoomStore, useValue: { lead: signal('idle') } },
        ...provideMockApi([
          [roomsAddAgent, register, (options) => [options.body]],
          [roomsRemoveAgent, globalRemove, (options) => [options.path]],
        ]),
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
    TestBed.overrideComponent(RoomAgents, { set: { providers: [{ provide: RoomAgentsStore, useValue: store }] } });
    const fixture = TestBed.createComponent(RoomAgents);
    const root = fixture.nativeElement as HTMLElement;
    const click = (id: string) => {
      const element = root.querySelector<HTMLElement>(`[data-testid=${id}]`);
      if (!element) throw new Error(`Missing ${id}`);
      element.click();
    };
    const fill = async (id: string, value: string) => {
      if (id === 'room-agent-host') {
        root.querySelector<HTMLButtonElement>(`[data-host-id="${value}"]`)?.click();
        await fixture.whenStable();
        return;
      }
      const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `[data-testid=${id}]`,
      );
      if (!input) throw new Error(`Missing ${id}`);
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    return { fixture, root, store, register, globalRemove, forOwner, click, fill };
  }
  it('always shows the Lead and keeps configuration out of the compact overview', async () => {
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-agent-lead]')?.textContent).toContain('Lead');
    expect(root.querySelector('input,select,textarea')).toBeNull();
    click('room-agent-add');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-agent-choices]')).not.toBeNull();
    click('room-agent-choose-external');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-agent-model]')).toBeNull();
  });
  it('adds a collaborator on a paired host without requiring a playbook or model selection', async () => {
    const { fixture, store, click, fill } = setup();
    await fixture.whenStable();
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-collaborator');
    await fixture.whenStable();
    await fill('room-agent-role', 'researcher');
    await fill('room-agent-host', 'paired-host');
    await fill('room-agent-instructions', 'Check the sources.');
    click('room-agent-save');
    await fixture.whenStable();
    expect(store.add).toHaveBeenCalledExactlyOnceWith({
      role: 'researcher',
      instructions: 'Check the sources.',
      agent: { machine: 'paired-host' },
    });
  });
  it('saves a collaborator model override and preserves drafts across target polling', async () => {
    const { fixture, root, store, click, fill } = setup();
    await fixture.whenStable();
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-collaborator');
    await fixture.whenStable();
    await fill('room-agent-role', 'reviewer');
    await fill('room-agent-model', 'provider/model');
    store.targets.set(structuredClone(targets));
    await fixture.whenStable();
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-agent-role]')?.value).toBe('reviewer');
    click('room-agent-save');
    await fixture.whenStable();
    expect(store.add).toHaveBeenCalledWith({
      role: 'reviewer',
      instructions: '',
      agent: { local: true },
      model: 'provider/model',
    });
  });
  it('renders the actual remote avatar on member rows, host tiles and the current host', async () => {
    const { fixture, root, store, click, fill } = setup([
      { role: 'reviewer', instructions: '', agent: { machine: 'paired-host' }, source: 'room' },
    ]);
    await fixture.whenStable();
    expect(root.querySelector('[data-role=reviewer] pk-avatar pk-env-glyph')?.getAttribute('data-icon')).toBe('neko');
    expect(root.querySelector('[data-testid=room-agent-lead] pk-avatar pk-env-glyph')?.getAttribute('data-icon')).toBe(
      'runner',
    );
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-collaborator');
    await fixture.whenStable();
    expect(root.querySelector('[data-host-id=paired-host] pk-env-glyph')?.getAttribute('data-icon')).toBe('neko');
    await fill('room-agent-host', 'paired-host');
    expect(
      root.querySelector('[data-testid=room-agent-selected-host] pk-avatar pk-env-glyph')?.getAttribute('data-icon'),
    ).toBe('neko');
    expect(store.showModels).toHaveBeenLastCalledWith('paired-host');
  });
  it('retains an unknown configured model on initial edit and resets to the selected host default when changing hosts', async () => {
    const { fixture, root, store, click, fill } = setup([
      { role: 'reviewer', instructions: '', agent: { local: true }, source: 'room', model: 'legacy/unknown' },
    ]);
    await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('[data-role=reviewer]')?.click();
    await fixture.whenStable();
    click('room-agent-edit');
    await fixture.whenStable();
    const models = root.querySelector<HTMLSelectElement>('[data-testid=room-agent-model]')!;
    expect(models.value).toBe('legacy/unknown');
    expect([...models.options].some((option) => option.value === 'legacy/unknown')).toBe(true);
    await fill('room-agent-host', 'paired-host');
    expect(models.value).toBe('');
    expect([...models.options].some((option) => option.value === 'legacy/unknown')).toBe(false);
    await fill('room-agent-model', 'provider/model');
    click('room-agent-save');
    await fixture.whenStable();
    expect(store.update).toHaveBeenCalledWith(
      'reviewer',
      expect.objectContaining({ agent: { machine: 'paired-host' }, model: 'provider/model' }),
    );
  });
  it('loads the local target catalog from the room host and shows actionable catalog failures with retry', async () => {
    const { fixture, root, store, click } = setup();
    store.context.set({ id: 'room-a', host: 'room-owner' });
    store.modelsError.set('Selected host model catalog is unavailable.');
    await fixture.whenStable();
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-collaborator');
    await fixture.whenStable();
    expect(store.showModels).toHaveBeenLastCalledWith('room-owner');
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Selected host model catalog');
    click('room-agent-model-retry');
    expect(store.retryModels).toHaveBeenCalledExactlyOnceWith();
    const models = root.querySelector<HTMLSelectElement>('[data-testid=room-agent-model]')!;
    expect(models.value).toBe('');
    expect(models.options[0].textContent).toContain('Selected host default');
  });
  it('attaches an existing external agent without offering a model override', async () => {
    const { fixture, root, store, click, fill } = setup();
    await fixture.whenStable();
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-external');
    await fixture.whenStable();
    await fill('room-agent-role', 'researcher');
    await fill('room-agent-external', 'external-id');
    click('room-agent-save');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-agent-model]')).toBeNull();
    expect(store.add).toHaveBeenCalledExactlyOnceWith({
      role: 'researcher',
      instructions: '',
      agent: { agent: 'external-id' },
    });
  });
  it('retains a registered agent after attach failure and retries without sending credentials or registering again', async () => {
    const { fixture, root, store, register, forOwner, click, fill } = setup();
    store.add.mockImplementationOnce(async () => {
      store.error.set('Could not add to room.');
      return false;
    });
    await fixture.whenStable();
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-external');
    await fixture.whenStable();
    await fill('room-agent-role', 'specialist');
    await fill('room-agent-external', '__new__');
    await fill('room-agent-url', 'https://new.example.test');
    await fill('room-agent-token', 'test-only-token');
    click('room-agent-save');
    await fixture.whenStable();
    await vi.waitFor(() => expect(store.add).toHaveBeenCalledTimes(1));
    await fixture.whenStable();
    expect(register).toHaveBeenCalledExactlyOnceWith({ url: 'https://new.example.test', token: 'test-only-token' });
    expect(forOwner).toHaveBeenCalledWith('local-host');
    expect(root.querySelector('[data-testid=room-agent-token]')).toBeNull();
    expect(root.querySelector('[data-testid=room-agent-registered]')?.textContent).toContain('registered');
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Could not add');
    click('room-agent-save');
    await fixture.whenStable();
    expect(register).toHaveBeenCalledTimes(1);
    expect(store.add).toHaveBeenLastCalledWith({
      role: 'specialist',
      instructions: '',
      agent: { agent: 'new-external-id' },
    });
    expect(root.querySelector('pk-room-dialog')).toBeNull();
  });
  it('does not attach a late registration after changing room hosts and clears the old token', async () => {
    const { fixture, root, store, register, click, fill } = setup();
    let finish: (agent: A2aAgent) => void = () => undefined;
    register.mockImplementationOnce(
      () =>
        new Promise<A2aAgent>((resolve) => {
          finish = resolve;
        }),
    );
    await fixture.whenStable();
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-external');
    await fixture.whenStable();
    await fill('room-agent-role', 'researcher');
    await fill('room-agent-external', '__new__');
    await fill('room-agent-url', 'https://new.example.test');
    await fill('room-agent-token', 'old-host-token');
    click('room-agent-save');
    await fixture.whenStable();
    store.context.set({ id: 'room-a', host: 'different-host' });
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    finish(registered);
    await fixture.whenStable();
    expect(store.add).not.toHaveBeenCalled();
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-external');
    await fixture.whenStable();
    await fill('room-agent-external', '__new__');
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-agent-token]')?.value).toBe('');
  });
  it('confirms room-only removal without deleting the globally registered agent', async () => {
    const { fixture, root, store, globalRemove, click } = setup([
      { role: 'researcher', instructions: '', agent: { agent: 'external-id' }, source: 'room' },
    ]);
    await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('[data-role=researcher]')?.click();
    await fixture.whenStable();
    click('room-agent-remove');
    await fixture.whenStable();
    expect(store.remove).not.toHaveBeenCalled();
    click('room-agent-remove-confirm');
    await fixture.whenStable();
    expect(store.remove).toHaveBeenCalledExactlyOnceWith('researcher');
    expect(globalRemove).not.toHaveBeenCalled();
  });
  it('updates inherited participants through room overrides and keeps the old role as the update identity', async () => {
    const { fixture, root, store, click, fill } = setup([
      { role: 'reviewer', instructions: 'Review changes.', agent: { local: true }, source: 'playbook' },
    ]);
    await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('[data-role=reviewer]')?.click();
    await fixture.whenStable();
    expect(root.textContent).toContain('Changes apply to this room only');
    click('room-agent-edit');
    await fixture.whenStable();
    await fill('room-agent-role', 'security');
    click('room-agent-save');
    await fixture.whenStable();
    expect(store.update).toHaveBeenCalledExactlyOnceWith('reviewer', {
      role: 'security',
      instructions: 'Review changes.',
      agent: { local: true },
    });
  });
  it('retains a failed collaborator draft and does not let an old save close a reopened dialog', async () => {
    const { fixture, root, store, click, fill } = setup();
    let finish: (value: boolean) => void = () => undefined;
    store.add.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await fixture.whenStable();
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-collaborator');
    await fixture.whenStable();
    await fill('room-agent-role', 'old-role');
    click('room-agent-save');
    await fixture.whenStable();
    click('room-dialog-dismiss');
    await fixture.whenStable();
    click('room-agent-add');
    await fixture.whenStable();
    click('room-agent-choose-collaborator');
    await fixture.whenStable();
    await fill('room-agent-role', 'new-role');
    finish(true);
    await fixture.whenStable();
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-agent-role]')?.value).toBe('new-role');
  });
});
