import { Component, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  PiDialogAnswer,
  PiDialogRequest,
  PlaybookDetail,
  Room,
  RoomAction,
  RoomEvent,
  RoomLeadState,
  RoomLive,
  RoomMemoryEntry,
  RoomRun,
  RoomTask,
  RoomTaskQuestion,
  RoomWorkerCandidate,
} from '@pi-kit/protocol';
import { OpenRoomStore, ROOM_DIALOG, ROOM_MCP_APP, ROOM_PROSE } from '@pi-kit/rooms/data';
import { RoomView } from './room-view';

@Component({ selector: 'pk-test-prose', template: '<em class="md-out">{{ text() }}</em>' })
class TestProse {
  readonly text = input.required<string>();
}

@Component({
  selector: 'pk-test-dialog',
  template: `
    <p class="dialog">{{ request().title }} {{ request().message }} {{ request().tool }}</p>
    @for (option of request().options ?? []; track option) {
      <button class="option" (click)="answered.emit({ value: option })">{{ option }}</button>
    }
    <button class="yes" (click)="answered.emit({ confirmed: true })">yes</button>
    <button class="text" (click)="answered.emit({ value: request().placeholder ?? '' })">text</button>
    <button class="dismiss" (click)="dismissed.emit()">dismiss</button>
  `,
})
class TestDialog {
  readonly request = input.required<PiDialogRequest>();
  readonly answered = output<PiDialogAnswer>();
  readonly dismissed = output<void>();
}

@Component({
  selector: 'pk-test-app',
  template:
    '<button class="app-out" (click)="send()(\'show tomorrow\')">{{ threadId() }} {{ ownerId() }} {{ app().resourceUri }}</button>',
})
class TestApp {
  readonly threadId = input.required<string>();
  readonly ownerId = input.required<string>();
  readonly app = input.required<{ resourceUri: string }>();
  readonly id = input.required<string>();
  readonly send = input.required<(text: string) => void>();
}

const room: Room = {
  id: 'a6f1d2c3-4b5e-4f6a-8b7c-9d0e1f2a3b4c',
  title: 'Watcher fix on Linux',
  repository: 'github.com/acme/pi-kit',
  hostInstanceId: '0b6c5bb4-3b1e-4a36-9ad2-7f6f8a1c2d01',
  baseCommit: 'a'.repeat(40),
  waiting: 0,
  createdAt: 1,
};
const event = (
  seq: number,
  actor: RoomEvent['actor'],
  text: string,
  kind: RoomEvent['kind'] = 'message',
  taskId: string | null = null,
): RoomEvent => ({
  roomId: room.id,
  seq,
  kind,
  actor,
  text,
  images: 0,
  taskId,
  createdAt: seq,
});

describe('RoomView', () => {
  const events = signal<RoomEvent[]>([]);
  const lead = signal<RoomLeadState>('idle');
  const post = vi.fn(async () => true);
  const store = {
    room: signal<Room | undefined>(room),
    summary: signal('Run the watcher tests on Linux.'),
    events,
    lead,
    loading: signal(false),
    error: signal<string | undefined>(undefined),
    sending: signal(false),
    leadThreadId: signal<string | null>(null),
    projectFolder: signal<string | null>('/srv/pi-kit'),
    folder: signal<string | null>('/data/rooms/a6f1d2c3'),
    archive: vi.fn(async () => true),
    mode: signal<'supervised' | 'assisted'>('supervised'),
    paused: signal(false),
    rehearsal: signal(false),
    playbook: signal<string | null>(null),
    playbookDetail: signal<PlaybookDetail | undefined>(undefined),
    playbookDetailError: signal<string | undefined>(undefined),
    loadPlaybookDetail: vi.fn(async () => undefined),
    tryTool: vi.fn(async () => ({ ran: true, ok: true, call: 'gh pr view 7', output: 'PR 7: Fix the watcher' })),
    fireTrigger: vi.fn(async () => ({
      text: '1 new among 2.',
      items: [
        { key: '7', fresh: true },
        { key: '6', fresh: false },
      ],
    })),
    playbookChoices: signal<
      { name: string; path: string; origin?: 'room' | 'repository'; error?: string | null }[] | undefined
    >(undefined),
    stage: signal<string | null>(null),
    stages: signal<string[]>([]),
    memory: signal<RoomMemoryEntry[]>([]),
    runs: signal<RoomRun[]>([]),
    live: signal<RoomLive[]>([]),
    pendingActions: signal<RoomAction[]>([]),
    decide: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    tasks: signal<RoomTask[]>([]),
    acting: signal<string | undefined>(undefined),
    act: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    leadQuestions: signal<RoomTaskQuestion[]>([]),
    answerLead: vi.fn(async () => undefined),
    workers: signal<RoomWorkerCandidate[]>([]),
    loadWorkers: vi.fn(async () => undefined),
    environmentName: (id: string) => (id === 'desk' ? 'Desktop' : undefined),
    machineName: (id: string | null | undefined) =>
      id === 'desk' ? 'pi-kit B' : id === room.hostInstanceId ? 'pi-kit A' : undefined,
    machineLook: (id: string | null | undefined) =>
      id === 'desk' ? { icon: 'drone', color: 3 } : id === room.hostInstanceId ? { icon: 'oni', color: 7 } : undefined,
    protection: signal<unknown>(undefined),
    setSandboxed: vi.fn(async () => undefined),
    post,
  };

  beforeEach(() => {
    events.set([]);
    lead.set('idle');
    post.mockClear();
    TestBed.configureTestingModule({
      providers: [
        { provide: OpenRoomStore, useValue: store },
        { provide: ROOM_DIALOG, useValue: () => Promise.resolve(TestDialog) },
      ],
    });
  });

  const render = () => {
    const fixture = TestBed.createComponent(RoomView);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  it('shows the room, the shared summary and an invitation to ask the lead', () => {
    const { el } = render();
    expect(el.querySelector('[data-testid=room-meta]')?.textContent).toContain('github.com/acme/pi-kit');
    expect(el.querySelector('[data-testid=room-summary]')?.textContent).toContain('Run the watcher tests on Linux.');
    expect(el.querySelector('[data-testid=room-folder]')?.textContent).toContain('/srv/pi-kit');
    expect(el.querySelector('[data-testid=room-empty]')).not.toBeNull();
  });

  it('shows a proposed task once, asks where to run it, and shows a submitted one with its files and Integrate', async () => {
    const task: RoomTask = {
      id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
      roomId: room.id,
      title: 'Add b',
      brief: 'Create b.txt.',
      acceptance: 'b.txt exists.',
      state: 'proposed',
      environmentId: room.hostInstanceId,
      attempt: 1,
      base: 'a'.repeat(40),
      branch: null,
      head: null,
      report: null,
      files: [],
      questions: [],
      review: 'none',
      reviewRounds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    store.tasks.set([task]);
    events.set([
      event(1, 'lead', 'Proposes “Add b”.', 'task', task.id),
      event(2, 'coordinator', 'Approved.', 'task', task.id),
    ]);
    const { fixture, el } = render();
    expect(el.querySelectorAll('[data-testid=room-task]')).toHaveLength(1);
    store.workers.set([
      { environmentId: room.hostInstanceId, name: 'Server', local: true, ready: true, reason: null },
      { environmentId: 'desk', name: 'Desktop', local: false, ready: true, reason: null },
      { environmentId: 'lap', name: 'Laptop', local: false, ready: false, reason: 'Laptop is offline.' },
    ]);
    (el.querySelector('[data-testid=room-task-approve]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    const choices = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid=room-task-run-on]'));
    expect(choices.map((b) => [b.textContent?.trim(), b.disabled])).toEqual([
      ['This computer', false],
      ['Desktop', false],
      ['Laptop', true],
    ]);
    choices[1].click();
    await fixture.whenStable();
    expect(store.act).toHaveBeenCalledWith(task.id, 'approve', 'desk');
    store.workers.set([]);
    expect(el.querySelector('[data-testid=room-note]')?.textContent).toContain('Approved.');
    store.tasks.set([
      {
        ...task,
        environmentId: 'desk',
        state: 'submitted',
        report: 'Added b.',
        files: [{ path: 'b.txt', added: 2, removed: 0 }],
      },
    ]);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=room-task-report]')?.textContent).toContain('Added b.');
    expect(el.querySelector('[data-testid=room-task] .where')?.textContent).toContain('Desktop');
    expect(el.querySelector('[data-testid=room-task-files]')?.textContent).toContain('b.txt');
    (el.querySelector('[data-testid=room-task-integrate]') as HTMLButtonElement).click();
    expect(store.act).toHaveBeenCalledWith(task.id, 'integrate');
    store.tasks.set([]);
  });

  it('shows what a running worker asks and sends the owner’s answers', async () => {
    const task: RoomTask = {
      id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
      roomId: room.id,
      title: 'Add b',
      brief: 'Create b.txt.',
      acceptance: '',
      state: 'running',
      environmentId: 'desk',
      attempt: 1,
      base: 'a'.repeat(40),
      branch: null,
      head: null,
      report: null,
      files: [],
      questions: [
        { id: 'd1', method: 'confirm', title: 'Run npm install?', tool: 'bash' },
        { id: 'd2', method: 'input', title: 'Which port?', placeholder: '4200' },
      ],
      review: 'none',
      reviewRounds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    store.tasks.set([task]);
    events.set([event(1, 'coordinator', 'The worker needs you.', 'task', task.id)]);
    const { fixture, el } = render();
    await fixture.whenStable();
    fixture.detectChanges();
    const block = el.querySelector('[data-testid=room-task-question]') as HTMLElement;
    const dialogs = block.querySelectorAll('pk-test-dialog');
    expect(dialogs[0]?.textContent).toContain('Run npm install?');
    expect(dialogs[0]?.textContent).toContain('bash');
    (dialogs[0]?.querySelector('.yes') as HTMLButtonElement).click();
    expect(store.answer).toHaveBeenCalledWith(task.id, [{ id: 'd1', confirmed: true }]);
    (dialogs[1]?.querySelector('.text') as HTMLButtonElement).click();
    expect(store.answer).toHaveBeenCalledWith(task.id, [{ id: 'd2', value: '4200' }]);
    store.tasks.set([]);
  });

  it('shows what the lead asks in place of Thinking and sends the owner’s answer', async () => {
    lead.set('working');
    store.leadQuestions.set([{ id: 'd1', method: 'select', title: 'Which log?', options: ['app.log', 'error.log'] }]);
    const { fixture, el } = render();
    await fixture.whenStable();
    fixture.detectChanges();
    const block = el.querySelector('[data-testid=room-lead-question]') as HTMLElement;
    expect(block.textContent).toContain('Which log?');
    expect(el.querySelector('[data-testid=room-lead-working] .thinking')).toBeNull();
    const options = block.querySelectorAll<HTMLButtonElement>('.option');
    expect([...options].map((option) => option.textContent?.trim())).toEqual(['app.log', 'error.log']);
    options[1].click();
    expect(store.answerLead).toHaveBeenCalledWith([{ id: 'd1', value: 'error.log' }]);
    (block.querySelector('.dismiss') as HTMLButtonElement).click();
    expect(store.answerLead).toHaveBeenCalledWith([{ id: 'd1', cancelled: true }]);
    store.leadQuestions.set([]);
  });

  it('switches the room between supervised and assisted, pauses it, and shows the lead’s review', () => {
    const task: RoomTask = {
      id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
      roomId: room.id,
      title: 'Add b',
      brief: 'Create b.txt.',
      acceptance: '',
      state: 'submitted',
      environmentId: 'desk',
      attempt: 2,
      base: 'a'.repeat(40),
      branch: 'pi-kit/add-b',
      head: 'b'.repeat(40),
      report: null,
      files: [],
      questions: [],
      review: 'accepted',
      reviewRounds: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    store.tasks.set([task]);
    events.set([event(1, 'coordinator', 'Ready.', 'task', task.id)]);
    const { el } = render();
    expect(el.querySelector('[data-testid=room-mode-supervised]')?.getAttribute('aria-checked')).toBe('true');
    (el.querySelector('[data-testid=room-mode-assisted]') as HTMLButtonElement).click();
    expect(store.update).toHaveBeenCalledWith({ mode: 'assisted' });
    (el.querySelector('[data-testid=room-pause]') as HTMLButtonElement).click();
    expect(store.update).toHaveBeenCalledWith({ paused: true });
    expect(el.querySelector('[data-testid=room-task-review]')?.textContent?.trim()).toBe(
      'Reviewed by lead · 2 round(s)',
    );
    store.tasks.set([]);
    events.set([]);
  });

  it('gives every speaker an avatar: the lead with its host machine, the worker with its own', () => {
    events.set([event(1, 'lead', 'Hi'), { ...event(2, 'worker', 'Which language?'), environmentId: 'desk' }]);
    const { el } = render();
    const lead = el.querySelector('[data-actor=lead]') as HTMLElement;
    expect(lead.querySelector('pk-avatar')?.getAttribute('aria-label')).toBe('Lead · pi-kit A');
    expect(lead.querySelector('.env')?.textContent?.trim()).toBe('pi-kit A');
    const worker = el.querySelector('[data-actor=worker]') as HTMLElement;
    expect(worker.querySelector('pk-avatar')?.getAttribute('aria-label')).toBe('Worker · pi-kit B');
    expect(worker.querySelector('pk-avatar .letter')?.textContent).toBe('B');
    expect(worker.querySelector('[data-testid=room-message-machine]')?.textContent?.trim()).toBe('pi-kit B');
    expect(worker.querySelector('.text')?.textContent).toBe('Which language?');
    events.set([]);
  });

  it('marks each avatar with the participant’s role and its machine’s look, also in the byline', () => {
    events.set([
      event(1, 'lead', 'Hi'),
      { ...event(2, 'worker', 'Done'), environmentId: 'desk' },
      { ...event(3, 'consultant', 'Looks fine'), role: 'reviewer' },
    ]);
    const { el } = render();
    const avatar = (actor: string) => el.querySelector(`[data-actor=${actor}] pk-avatar`) as HTMLElement;
    expect(avatar('lead').getAttribute('data-role')).toBe('lead');
    expect(avatar('lead').querySelector('.pk-avatar-badge.look')?.getAttribute('data-icon')).toBe('oni');
    expect(el.querySelector('[data-actor=lead] .env pk-env-glyph')?.getAttribute('data-icon')).toBe('oni');
    expect(avatar('worker').getAttribute('data-role')).toBe('worker');
    expect(avatar('worker').querySelector('.pk-avatar-badge.look')?.getAttribute('data-icon')).toBe('drone');
    expect(avatar('consultant').getAttribute('data-role')).toBe('consultant');
    expect(avatar('consultant').querySelector('.pk-avatar-badge.look')?.getAttribute('data-icon')).toBe('oni');
    events.set([]);
  });

  it('shows the playbook, its stages, the notebook, consultants by role and machine, and drafts to approve', () => {
    store.playbook.set('pr-review');
    store.stages.set(['review', 'verdict']);
    store.stage.set('review');
    store.memory.set([{ scope: 'room', key: 'decision', text: 'Ship it.', updatedBy: 'lead', updatedAt: 1 }]);
    const action: RoomAction = {
      id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      kind: 'call',
      name: 'post_review',
      summary: 'Post the review on PR 25.',
      payload: { argv: ['gh', 'pr', 'review', '25', '--body', 'Looks good'] },
      state: 'pending',
      result: null,
      createdAt: 1,
      decidedAt: null,
    };
    store.pendingActions.set([action]);
    events.set([
      event(1, 'lead', `Asks the security: ${'Is this safe? '.repeat(20)}`, 'note'),
      { ...event(2, 'consultant', 'No secrets in the diff.'), role: 'security', environmentId: 'desk' },
    ]);
    const { fixture, el } = render();
    expect(el.querySelector('[data-testid=room-playbook]')?.textContent).toContain('pr-review');
    expect(el.querySelector('[data-testid=room-stage][aria-current=step]')?.textContent?.trim()).toBe('review');
    expect(el.querySelector('[data-testid=room-notebook]')?.textContent).toContain('Ship it.');
    expect(el.querySelector('[data-testid=room-lead-note] summary')?.textContent).toContain('Asks the security');
    expect(el.querySelector('[data-actor=lead]')).toBeNull();
    const consultant = el.querySelector('[data-actor=consultant]') as HTMLElement;
    expect(consultant.querySelector('[data-testid=room-message-role]')?.textContent?.trim()).toBe('security');
    expect(consultant.querySelector('[data-testid=room-message-machine]')?.textContent?.trim()).toBe('pi-kit B');
    expect(el.querySelector('[data-testid=room-action-argv]')?.textContent).toBe("gh pr review 25 --body 'Looks good'");
    store.pendingActions.set([
      { ...action, payload: { mcp: { server: 'linear', tool: 'save_comment', args: { issue: 'T-1' } } } },
    ]);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=room-action-argv]')?.textContent).toContain('linear · save_comment');
    store.pendingActions.set([action]);
    fixture.detectChanges();
    (el.querySelector('[data-testid=room-action-approve]') as HTMLButtonElement).click();
    expect(store.decide).toHaveBeenCalledWith(action.id, 'approve');
    store.playbook.set(null);
    store.stages.set([]);
    store.memory.set([]);
    store.pendingActions.set([]);
    events.set([]);
  });

  it('says the lead is read-only, and sandboxed when its sandbox runs', () => {
    const { fixture, el } = render();
    const lock = () => el.querySelector('[data-testid=room-lead-lock]') as HTMLElement;
    expect(lock().textContent?.trim()).toBe('Read-only · this computer');
    store.protection.set({ mode: 'sandboxed', state: 'active' });
    fixture.detectChanges();
    expect(lock().textContent?.trim()).toBe('Read-only · sandboxed');
    expect(lock().getAttribute('data-mode')).toBe('sandboxed');
    store.protection.set(undefined);
  });

  describe('the playbook picker', () => {
    const pick = (el: HTMLElement, value: string) => {
      const select = el.querySelector<HTMLSelectElement>('[data-testid=room-playbook-select]')!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
    };

    afterEach(() => {
      store.playbook.set(null);
      store.playbookChoices.set(undefined);
      lead.set('idle');
      store.update.mockClear();
    });

    it('attaches, switches and removes a playbook of the room’s folder, but not while the lead works', () => {
      store.playbookChoices.set([
        { name: 'triage', path: '/p/triage' },
        { name: 'broken', path: '/p/broken', error: 'room.yaml: bad' },
      ]);
      const { fixture, el } = render();
      expect(el.querySelector<HTMLOptionElement>('option[value=broken]')?.disabled).toBe(true);
      expect(el.querySelector('[data-testid=room-playbook-hint]')).toBeNull();
      pick(el, 'triage');
      expect(store.update).toHaveBeenCalledWith({ playbook: 'triage' });
      store.playbook.set('triage');
      fixture.detectChanges();
      pick(el, '');
      expect(store.update).toHaveBeenLastCalledWith({ playbook: null });
      lead.set('working');
      fixture.detectChanges();
      expect(el.querySelector<HTMLSelectElement>('[data-testid=room-playbook-select]')?.disabled).toBe(true);
    });

    it('says where playbooks go when the folder has none, and asks the lead to write one', () => {
      store.playbookChoices.set([]);
      const { el } = render();
      expect(el.querySelector('[data-testid=room-playbook-hint]')?.textContent).toContain('room’s own folder');
      pick(el, 'ask-lead');
      expect(post).toHaveBeenCalledWith(expect.stringContaining('room_playbook_guide'), 'lead');
      expect(store.update).not.toHaveBeenCalled();
    });
  });

  it('turns the lead’s sandbox off and on, but not while the lead works', () => {
    store.leadThreadId.set('lead-thread');
    store.protection.set({ mode: 'sandboxed', state: 'active' });
    const { fixture, el } = render();
    const lock = () => el.querySelector<HTMLButtonElement>('[data-testid=room-lead-lock]')!;
    lock().click();
    expect(store.setSandboxed).toHaveBeenCalledWith(false);
    store.protection.set({ mode: 'bypass', state: 'idle' } as never);
    fixture.detectChanges();
    lock().click();
    expect(store.setSandboxed).toHaveBeenLastCalledWith(true);
    lead.set('working');
    fixture.detectChanges();
    expect(lock().disabled).toBe(true);
    store.leadThreadId.set(null);
    store.protection.set(undefined);
  });

  it('shows the owner, the lead, notes and a thinking lead', () => {
    events.set([
      event(1, 'owner', 'Hello'),
      event(2, 'lead', 'Hi, I would propose a task.'),
      event(3, 'coordinator', 'Stopped.', 'note'),
    ]);
    lead.set('working');
    const { el } = render();
    expect(
      Array.from(el.querySelectorAll('[data-testid=room-message]')).map((m) => m.getAttribute('data-actor')),
    ).toEqual(['owner', 'lead']);
    expect(el.querySelector('[data-testid=room-note]')?.textContent).toContain('Stopped.');
    expect(el.querySelector('[data-testid=room-lead-working]')).not.toBeNull();
  });

  it('renders the lead’s replies as Markdown and keeps the owner’s words as typed', async () => {
    TestBed.overrideProvider(ROOM_PROSE, { useValue: () => Promise.resolve(TestProse) });
    events.set([event(1, 'owner', '**not bold**'), event(2, 'lead', '**Plan**\n\n- one')]);
    const { fixture, el } = render();
    await fixture.whenStable();
    fixture.detectChanges();
    const lead = el.querySelector('[data-actor=lead] [data-testid=room-message-markdown] .md-out');
    expect(lead?.textContent).toBe('**Plan**\n\n- one');
    expect(el.querySelector('[data-actor=owner]')?.textContent).toContain('**not bold**');
    expect(el.querySelector('[data-actor=owner] .md-out')).toBeNull();
    events.set([]);
  });

  it('draws an MCP App the lead opened on the lead’s thread and hands what the app says to the lead', async () => {
    TestBed.overrideProvider(ROOM_MCP_APP, { useValue: () => Promise.resolve(TestApp) });
    store.leadThreadId.set('lead-thread');
    const app = {
      serverHash: 'pi-mcp:calendar',
      serverId: 'calendar',
      tool: 'list_events',
      resourceUri: 'ui://calendar/day',
      result: { content: [] },
    };
    events.set([{ ...event(1, 'lead', 'list_events', 'app'), app }]);
    const { fixture, el } = render();
    await fixture.whenStable();
    fixture.detectChanges();
    const frame = el.querySelector<HTMLButtonElement>('[data-testid=room-app] .app-out');
    expect(frame?.textContent).toBe(`lead-thread ${room.hostInstanceId} ui://calendar/day`);
    frame?.click();
    expect(post).toHaveBeenCalledWith('show tomorrow', 'lead');
    store.leadThreadId.set(null);
    events.set([]);
  });

  it('attaches images for the lead, shows them, and sends them with the message', async () => {
    const { fixture, el } = render();
    const view = fixture.componentInstance as unknown as {
      pick(input: { files: File[]; value: string }): Promise<void>;
    };
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    const text = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    await view.pick({ files: [png, text], value: '' });
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid=room-attachments] img')).toHaveLength(1);
    const draft = el.querySelector('[data-testid=room-draft]') as HTMLTextAreaElement;
    draft.value = 'What is wrong here?';
    draft.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (el.querySelector('[data-testid=room-send]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(post).toHaveBeenCalledWith('What is wrong here?', 'lead', [{ mimeType: 'image/png', data: 'iVBORw==' }]);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=room-attachments]')).toBeNull();
    (el.querySelector('[data-testid=route-none]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect((el.querySelector('[data-testid=room-attach]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends to the lead with Enter, can just post, and waits while the lead answers', async () => {
    const { fixture, el } = render();
    const draft = el.querySelector('[data-testid=room-draft]') as HTMLTextAreaElement;
    draft.value = 'Can Desktop run this?';
    draft.dispatchEvent(new Event('input'));
    draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    expect(post).toHaveBeenCalledWith('Can Desktop run this?', 'lead', []);
    (el.querySelector('[data-testid=route-none]') as HTMLButtonElement).click();
    draft.value = 'A note';
    draft.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (el.querySelector('[data-testid=room-send]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(post).toHaveBeenLastCalledWith('A note', 'none', []);
    lead.set('working');
    draft.value = 'Again';
    draft.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect((el.querySelector('[data-testid=room-send]') as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows a playbook the lead proposes as a diff with what the check found, and applies it', () => {
    const action: RoomAction = {
      id: 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      kind: 'playbook',
      name: 'pr-review',
      summary: 'Poll every five minutes.',
      payload: {
        name: 'pr-review',
        folder: '.pi/skills/pr-review',
        create: false,
        skill: '---\nname: pr-review\n---\n',
        yaml: 'tools: {}\n',
        base: 'abc',
        files: [
          {
            path: '.pi/skills/pr-review/room.yaml',
            written: false,
            hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-every: 1m', '+every: 5m'] }],
          },
        ],
        checks: [
          { level: 'ok', subject: 'command gh', message: 'Found.' },
          { level: 'error', subject: 'mcp linear', message: 'linear is not signed in yet.' },
        ],
      },
      state: 'pending',
      result: null,
      createdAt: 1,
      decidedAt: null,
    };
    store.pendingActions.set([action]);
    const { el } = render();
    const card = el.querySelector('[data-testid=room-action][data-kind=playbook]') as HTMLElement;
    expect(card.querySelector('[data-testid=room-proposal-file]')?.textContent).toContain('room.yaml');
    expect(card.querySelector('pk-diff')?.textContent).toContain('every: 5m');
    expect([...card.querySelectorAll('[data-testid=room-proposal-check]')].map((check) => check.textContent)).toEqual([
      expect.stringContaining('linear is not signed in yet.'),
    ]);
    (card.querySelector('[data-testid=room-action-approve]') as HTMLButtonElement).click();
    expect(store.decide).toHaveBeenCalledWith(action.id, 'approve');
    store.pendingActions.set([]);
  });

  it('opens the playbook: what wakes the lead, its stages, tools to try, triggers to fire, and a rehearsal', async () => {
    store.playbook.set('pr-review');
    store.playbookDetail.set({
      name: 'pr-review',
      description: 'Review pull requests.',
      folder: '.pi/skills/pr-review',
      origin: 'repository',
      skill: '---\nname: pr-review\n---\nReview them.',
      yaml: 'stages: [review, verdict]\n',
      config: {
        lead: { model: 'local/gemma' },
        workers: { thinking: 'medium' },
        participants: [
          {
            role: 'security',
            agent: { machine: 'pi-kit B' },
            instructions: 'Look for secrets.',
            model: 'anthropic/claude-opus-5-5',
            thinking: 'high',
          },
        ],
        tools: {
          open_prs: { run: ['gh', 'pr', 'list'], description: 'Open pull requests.' },
          show: { run: ['gh', 'pr', 'view', '{pr}'], description: '' },
        },
        'safe-outputs': { comment: { run: ['gh', 'pr', 'comment', '{pr}'], description: '', mode: 'draft', max: 5 } },
        vars: {},
        on: { schedule: [], poll: [{ id: 'prs', tool: 'open_prs', every: '5m', with: {}, say: '' }] },
        stages: ['review', 'verdict'],
        gates: { verdict: 'owner' },
      },
      error: null,
      stage: 'review',
      triggers: [
        { id: 'prs', kind: 'poll', every: '5m', cron: null, tool: 'open_prs', say: '', lastRun: null, nextRun: 1 },
      ],
      usage: { comment: 2 },
      checks: [{ level: 'warn', subject: 'participant security', message: 'pi-kit B is offline.' }],
    });
    const { fixture, el } = render();
    expect(el.querySelector('[data-testid=room-playbook-panel]')).toBeNull();
    expect(el.querySelector('[data-testid=room-side-trigger]')?.textContent).toContain('every 5m · open_prs');
    (el.querySelector('[data-testid=room-playbook-open]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const panel = el.querySelector('[data-testid=room-playbook-panel]') as HTMLElement;
    expect(panel.querySelector('[data-testid=room-playbook-trigger]')?.textContent).toContain('open_prs');
    expect(panel.querySelector('[data-testid=room-playbook-stage][aria-current=step]')?.textContent?.trim()).toBe(
      'review',
    );
    expect(panel.querySelector('[data-testid=room-playbook-participant]')?.textContent).toContain(
      'pi-kit B is offline.',
    );
    expect(panel.querySelector('[data-testid=room-playbook-lead-model]')?.textContent).toBe('local/gemma');
    expect(panel.querySelector('[data-testid=room-playbook-workers-model]')?.textContent).toContain('thinking');
    expect(panel.querySelector('[data-testid=room-playbook-participant-model]')?.textContent).toContain(
      'anthropic/claude-opus-5-5 · thinking',
    );
    expect(panel.querySelector('[data-name=comment]')?.textContent).toContain('2 of 5 today');

    const show = panel.querySelector('[data-name=show]') as HTMLElement;
    const param = show.querySelector('input') as HTMLInputElement;
    param.value = '7';
    param.dispatchEvent(new Event('input'));
    (show.querySelector('[data-testid=room-playbook-try]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.tryTool).toHaveBeenCalledWith('show', { pr: '7' });
    expect(show.querySelector('[data-testid=room-playbook-try-result]')?.textContent).toContain(
      'PR 7: Fix the watcher',
    );

    (panel.querySelector('[data-testid=room-trigger-dry]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.fireTrigger).toHaveBeenCalledWith('prs', true);
    expect(panel.querySelector('[data-testid=room-trigger-result] .fresh')?.textContent).toBe('7');

    const rehearse = panel.querySelector('[data-testid=room-rehearsal]') as HTMLInputElement;
    rehearse.checked = true;
    rehearse.dispatchEvent(new Event('change'));
    expect(store.update).toHaveBeenCalledWith({ rehearsal: true });

    (panel.querySelector('[data-testid=room-playbook-change]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect((el.querySelector('[data-testid=room-draft]') as HTMLTextAreaElement).value).toBe('Change the playbook: ');
    expect(el.querySelector('[data-testid=room-playbook-panel]')).toBeNull();
    store.playbook.set(null);
    store.playbookDetail.set(undefined);
  });

  it('keeps the room’s controls in a bar that does not scroll, and renames and archives from its menu', async () => {
    const running: RoomTask = {
      id: 'd1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
      roomId: room.id,
      title: 'Add c',
      brief: 'Create c.txt.',
      acceptance: '',
      state: 'running',
      environmentId: 'desk',
      attempt: 1,
      base: 'a'.repeat(40),
      branch: null,
      head: null,
      report: null,
      files: [],
      questions: [],
      review: 'none',
      reviewRounds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    store.tasks.set([running]);
    const { fixture, el } = render();
    const bar = el.querySelector('[data-testid=room-bar]') as HTMLElement;
    expect(el.querySelector('.pk-room-scroll')?.contains(bar)).toBe(false);
    expect(bar.querySelector('[data-testid=room-mode]')).not.toBeNull();

    (bar.querySelector('[data-testid=room-rename]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const title = bar.querySelector('[data-testid=room-title-input]') as HTMLInputElement;
    expect(title.value).toBe('Watcher fix on Linux');
    title.value = '  Watcher fix everywhere ';
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(store.update).toHaveBeenLastCalledWith({ title: 'Watcher fix everywhere' });
    expect(bar.querySelector('[data-testid=room-title-input]')).toBeNull();

    (bar.querySelector('[data-testid=room-archive]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const dialog = el.querySelector('[data-testid=room-archive-dialog]') as HTMLElement;
    expect(dialog.querySelector('[data-testid=room-archive-running]')?.textContent).toContain('1 task(s)');
    (dialog.querySelector('[data-testid=room-archive-leave]') as HTMLInputElement).dispatchEvent(new Event('change'));
    (dialog.querySelector('[data-testid=room-archive-confirm]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.archive).toHaveBeenCalledWith(false);
    expect(el.querySelector('[data-testid=room-archive-dialog]')).toBeNull();
    store.tasks.set([]);
  });

  it('shows runs like a workflow’s: the list in the side panel, and each run with its trigger, steps and output', () => {
    const run = (number: number, state: RoomRun['state'], steps: RoomRun['steps']): RoomRun => ({
      id: `run-${number}`,
      roomId: room.id,
      number,
      cause: number === 2 ? 'poll' : 'owner',
      trigger: number === 2 ? 'prs' : null,
      title: number === 2 ? '1 new: 7' : 'Which pull requests wait?',
      playbook: 'pr-review',
      stage: 'review',
      state,
      summary: number === 2 ? null : 'Two wait on you.',
      startedAt: 1_000,
      endedAt: state === 'running' ? null : 15_000,
      steps,
    });
    store.runs.set([
      run(2, 'running', [
        {
          seq: 1,
          kind: 'tool',
          name: 'show',
          detail: 'gh pr view 7',
          state: 'done',
          output: 'PR 7: Fix the watcher',
          startedAt: 1_000,
          endedAt: 3_000,
        },
        {
          seq: 2,
          kind: 'output',
          name: 'comment',
          detail: 'gh pr comment 7',
          state: 'waiting',
          output: null,
          startedAt: 3_000,
          endedAt: null,
        },
      ]),
      run(1, 'done', []),
    ]);
    const { fixture, el } = render();
    const rows = [...el.querySelectorAll<HTMLButtonElement>('[data-testid=room-side-run]')];
    expect(rows.map((row) => [row.getAttribute('data-state'), row.querySelector('.title')?.textContent])).toEqual([
      ['running', '1 new: 7'],
      ['done', 'Which pull requests wait?'],
    ]);
    rows[1]?.click();
    fixture.detectChanges();
    const dialog = el.querySelector('[data-testid=room-runs-dialog]') as HTMLElement;
    const detail = () => dialog.querySelector('[data-testid=room-run-detail]') as HTMLElement;
    expect(detail().querySelector('h3')?.textContent).toBe('Which pull requests wait?');
    expect(detail().querySelector('[data-testid=room-run-no-steps]')).not.toBeNull();
    expect(detail().querySelector('[data-testid=room-run-summary]')?.textContent?.trim()).toBe('Two wait on you.');
    expect(detail().querySelector('.facts')?.textContent).toContain('14s');

    dialog.querySelectorAll<HTMLButtonElement>('[data-testid=room-run]')[0]?.click();
    fixture.detectChanges();
    expect(detail().querySelector('.facts')?.textContent).toContain('New items · prs');
    const steps = [...detail().querySelectorAll('[data-testid=step]')];
    expect(steps.map((step) => [step.querySelector('.name')?.textContent, step.getAttribute('data-state')])).toEqual([
      ['show', 'done'],
      ['comment', 'waiting'],
    ]);
    expect(steps[0]?.querySelector('.tag')?.textContent).toBe('Tool');
    expect(steps[0]?.querySelector('[data-testid=step-output]')?.textContent).toBe('PR 7: Fix the watcher');
    expect(steps[0]?.querySelector('.duration')?.textContent).toBe('2s');
    expect(steps[1]?.querySelector('pk-run-status')?.getAttribute('aria-label')).toBe('Waiting for you');
    store.runs.set([]);
  });

  it('shows what each participant is writing as it comes, with the tool it is using, in place of Thinking', () => {
    const speaker = (id: string, actor: RoomLive['actor'], more: Partial<RoomLive>): RoomLive => ({
      id,
      actor,
      role: null,
      taskId: null,
      environmentId: null,
      text: '',
      reset: false,
      activity: null,
      done: false,
      ...more,
    });
    lead.set('working');
    const { fixture, el } = render();
    expect(el.querySelector('[data-testid=room-lead-working] .thinking')).not.toBeNull();
    store.live.set([
      speaker('l1', 'lead', { text: 'Two pull requests wait' }),
      speaker('l2', 'consultant', { role: 'security', environmentId: 'desk', activity: 'grep' }),
      speaker('l3', 'worker', { environmentId: 'desk', text: 'Adding b.txt' }),
    ]);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=room-lead-working]')).toBeNull();
    const live = [...el.querySelectorAll<HTMLElement>('[data-testid=room-live]')];
    expect(live.map((row) => row.getAttribute('data-actor'))).toEqual(['lead', 'consultant', 'worker']);
    expect(live[0]?.querySelector('[data-testid=room-live-text]')?.textContent).toBe('Two pull requests wait');
    expect(live[0]?.querySelector('pk-avatar')?.getAttribute('aria-label')).toBe('Lead · pi-kit A');
    expect(live[1]?.querySelector('b')?.textContent).toBe('security');
    expect(live[1]?.querySelector('[data-testid=room-live-activity]')?.textContent?.trim()).toBe('using grep');
    expect(live[1]?.querySelector('[data-testid=room-live-text]')).toBeNull();
    expect(live[2]?.querySelector('pk-avatar')?.getAttribute('aria-label')).toBe('Worker · pi-kit B');
    store.live.set([]);
    lead.set('idle');
  });

  it('lists tasks by what they need, the room’s own folder and its playbooks in a side panel that can be hidden', () => {
    const task = (id: string, title: string, state: RoomTask['state']): RoomTask => ({
      id,
      roomId: room.id,
      title,
      brief: '',
      acceptance: '',
      state,
      environmentId: 'desk',
      attempt: 1,
      base: 'a'.repeat(40),
      branch: null,
      head: null,
      report: null,
      files: [],
      questions: [],
      review: 'none',
      reviewRounds: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    store.tasks.set([
      task('t1', 'Add b', 'proposed'),
      task('t2', 'Add c', 'running'),
      task('t3', 'Add d', 'integrated'),
    ]);
    store.playbookChoices.set([
      { name: 'triage', path: '/data/rooms/a6f1d2c3/playbooks/triage/SKILL.md', origin: 'room' },
      { name: 'pr-review', path: '/srv/pi-kit/.pi/skills/pr-review/SKILL.md', origin: 'repository' },
    ]);
    const { fixture, el } = render();
    const side = el.querySelector('[data-testid=room-side]') as HTMLElement;
    expect(el.querySelector('.pk-room-scroll')?.contains(side)).toBe(false);
    expect([...side.querySelectorAll('[data-testid=room-side-tasks] h4')].map((h) => h.textContent?.trim())).toEqual([
      'Needs you',
      'Running',
      'Done',
    ]);
    expect(
      [...side.querySelectorAll('[data-testid=room-side-task]')].map((row) => row.getAttribute('data-state')),
    ).toEqual(['proposed', 'running', 'integrated']);
    expect(side.querySelector('[data-testid=room-own-folder]')?.textContent).toContain('/data/rooms/a6f1d2c3');
    expect(
      [...side.querySelectorAll('[data-testid=room-side-playbook]')].map((node) => [
        node.getAttribute('data-origin'),
        node.textContent?.trim(),
      ]),
    ).toEqual([
      ['room', 'triage'],
      ['repository', 'pr-review'],
    ]);
    expect(side.querySelector('[data-testid=room-side-no-triggers]')).not.toBeNull();
    (el.querySelector('[data-testid=room-side-toggle]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=room-side]')).toBeNull();
    (el.querySelector('[data-testid=room-side-toggle]') as HTMLButtonElement).click();
    store.tasks.set([]);
    store.playbookChoices.set(undefined);
  });

  it('keeps the mobile panel closed initially and dismisses it without changing the desktop preference', async () => {
    let narrow = true;
    const media = window.matchMedia('(max-width: 900px)');
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...media,
      media: query,
      matches: query === '(max-width: 900px)' && narrow,
    }));
    const saved = localStorage.getItem('pi-kit.roomSide');
    localStorage.setItem('pi-kit.roomSide', 'open');
    try {
      const fixture = TestBed.createComponent(RoomView);
      await fixture.whenStable();
      const el = fixture.nativeElement as HTMLElement;
      const toggle = () => el.querySelector<HTMLButtonElement>('[data-testid=room-side-toggle]')!;
      const panel = () => el.querySelector<HTMLElement>('[data-testid=room-side]');
      expect(panel()).toBeNull();

      for (const dismiss of ['close', 'backdrop', 'escape']) {
        toggle().click();
        await fixture.whenStable();
        expect(panel()?.getAttribute('role')).toBe('dialog');
        expect(panel()?.getAttribute('aria-modal')).toBe('true');
        expect(el.querySelector('.pk-room-main')?.hasAttribute('inert')).toBe(true);
        if (dismiss === 'escape')
          panel()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else el.querySelector<HTMLButtonElement>(`[data-testid=room-side-${dismiss}]`)?.click();
        await fixture.whenStable();
        expect(panel()).toBeNull();
        expect(el.querySelector('.pk-room-main')?.hasAttribute('inert')).toBe(false);
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
        expect(localStorage.getItem('pi-kit.roomSide')).toBe('open');
      }

      narrow = false;
      window.dispatchEvent(new Event('resize'));
      await fixture.whenStable();
      expect(panel()?.getAttribute('role')).toBe('complementary');
      narrow = true;
      window.dispatchEvent(new Event('resize'));
      await fixture.whenStable();
      expect(panel()).toBeNull();
    } finally {
      matchMedia.mockRestore();
      if (saved === null) localStorage.removeItem('pi-kit.roomSide');
      else localStorage.setItem('pi-kit.roomSide', saved);
    }
  });
});
