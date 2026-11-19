import { Component, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Room, RoomEvent, RoomLeadState, RoomTask, RoomTaskQuestion, RoomWorkerCandidate } from '@pi-kit/protocol';
import { OpenRoomStore, ROOM_PROSE } from '@pi-kit/rooms/data';
import { RoomView } from './room-view';

@Component({ selector: 'pk-test-prose', template: '<em class="md-out">{{ text() }}</em>' })
class TestProse {
  readonly text = input.required<string>();
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
    mode: signal<'supervised' | 'assisted'>('supervised'),
    paused: signal(false),
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
    protection: signal<unknown>(undefined),
    post,
  };

  beforeEach(() => {
    events.set([]);
    lead.set('idle');
    post.mockClear();
    TestBed.configureTestingModule({
      providers: [{ provide: OpenRoomStore, useValue: store }],
    });
  });

  const render = () => {
    const fixture = TestBed.createComponent(RoomView);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  it('shows the room, the shared summary and an invitation to ask the lead', () => {
    const { el } = render();
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Watcher fix on Linux');
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

  it('shows what a running worker asks and sends the owner’s answers', () => {
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
    const block = el.querySelector('[data-testid=room-task-question]') as HTMLElement;
    expect(block.textContent).toContain('Run npm install?');
    expect(block.textContent).toContain('bash');
    (block.querySelector('[data-testid=room-task-allow]') as HTMLButtonElement).click();
    expect(store.answer).toHaveBeenCalledWith(task.id, [{ id: 'd1', confirmed: true }]);
    const reply = block.querySelector('[data-testid=room-task-reply]') as HTMLTextAreaElement;
    expect(reply.placeholder).toBe('4200');
    reply.value = '5173';
    reply.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (block.querySelector('[data-testid=room-task-send-reply]') as HTMLButtonElement).click();
    expect(store.answer).toHaveBeenCalledWith(task.id, [{ id: 'd2', value: '5173' }]);
    store.tasks.set([]);
  });

  it('shows what the lead asks in place of Thinking and sends the owner’s answer', () => {
    lead.set('working');
    store.leadQuestions.set([{ id: 'd1', method: 'select', title: 'Which log?', options: ['app.log', 'error.log'] }]);
    const { el } = render();
    const block = el.querySelector('[data-testid=room-lead-question]') as HTMLElement;
    expect(block.textContent).toContain('Which log?');
    expect(el.querySelector('[data-testid=room-lead-working] .thinking')).toBeNull();
    const options = block.querySelectorAll<HTMLButtonElement>('[data-testid=room-task-option]');
    expect([...options].map((option) => option.textContent?.trim())).toEqual(['app.log', 'error.log']);
    options[1].click();
    expect(store.answerLead).toHaveBeenCalledWith([{ id: 'd1', value: 'error.log' }]);
    (block.querySelector('[data-testid=room-task-skip]') as HTMLButtonElement).click();
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
});
