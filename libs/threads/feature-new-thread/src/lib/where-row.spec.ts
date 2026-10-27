import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, threadsPlace, workspacesGit } from '@pi-kit/api';
import { ChatStore, ComposerExtensions, type InputTransform } from '@pi-kit/chat/api';
import type { ProjectGit, ThreadSummary, Workspace, WorktreeSettings } from '@pi-kit/protocol';
import { thread as fakeThread } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/data';
import { NewThreadPage } from './new-thread-page';
import { WhereHint } from './where-hint';
import { WhereRow } from './where-row';

const git = (over: Partial<ProjectGit> = {}): ProjectGit => ({
  git: true,
  branch: 'main',
  head: null,
  dirty: 3,
  branches: [
    { name: 'main', current: true, heldBy: null },
    { name: 'develop', current: false, heldBy: null },
    { name: 'pi-kit/settings-ux', current: false, heldBy: { path: '/wt/settings-ux', thread: 'Settings v2 proposal' } },
  ],
  remoteBranches: ['origin/main'],
  hasRemote: true,
  ...over,
});

const settings = (over: Partial<WorktreeSettings> = {}): WorktreeSettings => ({
  root: null,
  base: null,
  setup: null,
  defaultRoot: '/Users/me/.pi-kit/worktrees',
  git: true,
  start: 'local',
  allowBranchSwitch: true,
  carryChanges: 'ask',
  branchMode: 'named',
  branchPrefix: 'pi-kit/',
  removeFolder: 'ask',
  setupScripts: [{ id: 'node', name: 'Node', command: 'npm ci' }],
  ...over,
});

describe('the new-thread page and the Where row', () => {
  let selected: ReturnType<typeof signal<ThreadSummary | undefined>>;
  let messages: ReturnType<typeof signal<unknown[]>>;
  let draft: ReturnType<typeof signal<string>>;
  let workspaces: ReturnType<typeof signal<Workspace[]>>;
  let transforms: InputTransform[];
  const api = { projectGit: vi.fn(async () => git()), place: vi.fn(async () => undefined) };
  const threads = {
    selected: () => selected(),
    selectedId: () => selected()?.id,
    threads: () =>
      [
        selected(),
        fakeThread('old', {
          cwd: '/Users/me/Development/pi-kit',
          title: 'Settings v2 proposal',
          messageCount: 5,
          updatedAt: Date.now() - 3_600_000,
        }),
      ].filter(Boolean) as ThreadSummary[],
    workspaces: () => workspaces(),
    visibleProjects: () => workspaces().map((workspace) => ({ workspace, threads: [] })),
    refresh: vi.fn(async () => undefined),
    setWorktreeSettings: vi.fn(async () => undefined),
    select: vi.fn(),
    create: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  const chat = { messages: () => messages(), draft: () => draft(), focusComposer: vi.fn() };

  const CWD = '/Users/me/Development/pi-kit';
  const workspace = (worktree: WorktreeSettings): Workspace => ({
    cwd: CWD,
    name: 'pi-kit',
    lastOpenedAt: 1,
    threadCount: 0,
    collapsed: false,
    hidden: false,
    attendant: true,
    agents: false,
    branch: 'main',
    worktree,
  });

  beforeEach(() => {
    selected = signal<ThreadSummary | undefined>(fakeThread('n1', { cwd: CWD, messageCount: 0, origin: 'app' }));
    messages = signal<unknown[]>([]);
    draft = signal('');
    workspaces = signal<Workspace[]>([workspace(settings())]);
    transforms = [];
    api.projectGit.mockResolvedValue(git());
    for (const fn of [api.place, threads.refresh, threads.select, threads.setWorktreeSettings]) fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: ChatStore, useValue: chat },
        {
          provide: ComposerExtensions,
          useValue: { addTransform: (t: InputTransform) => (transforms.push(t), () => undefined) },
        },
        ...provideMockApi([
          [workspacesGit, api.projectGit, (o) => [o.path?.['id']]],
          [threadsPlace, api.place, (o) => [o.path?.['id'], o.body]],
        ]),
      ],
    });
  });

  const render = async <T>(type: new () => T) => {
    const fixture = TestBed.createComponent(type);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    return fixture;
  };
  const text = (root: { nativeElement: HTMLElement }, id: string): string =>
    (root.nativeElement.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const click = (root: { nativeElement: HTMLElement }, id: string): void =>
    (root.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement).click();

  it('shows the heading, the lead and the last thread to continue for a thread without messages, and nothing for one that has them', async () => {
    const fixture = await render(NewThreadPage);
    expect(fixture.nativeElement.querySelector('h2').textContent).toBe('What are we doing in pi-kit?');
    expect(text(fixture, 'recent-thread')).toContain('Continue “Settings v2 proposal”');
    messages.set([{}]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid=new-thread-page]')).toBeNull();
  });

  it('offers an unsent draft, and picking the last thread opens it', async () => {
    draft.set('Fix the cramped row');
    const fixture = await render(NewThreadPage);
    expect(text(fixture, 'recent-draft')).toContain('a draft you did not send');
    click(fixture, 'recent-thread');
    expect(threads.select).toHaveBeenCalledWith('old');
    click(fixture, 'recent-draft');
    expect(chat.focusComposer).toHaveBeenCalled();
  });

  it('Local: the sentence, the branch that is checked out, "the folder as it is" and no setup script until one is chosen', async () => {
    const fixture = await render(WhereRow);
    expect(text(fixture, 'where-sentence')).toBe('in ~/Development/pi-kit as it is');
    expect(text(fixture, 'where-branch')).toBe('main');
    expect(text(fixture, 'where-from')).toBe('the folder as it is');
    expect(text(fixture, 'where-setup')).toBe('none');
    expect(fixture.nativeElement.querySelector('[data-testid=where-local]').getAttribute('aria-checked')).toBe('true');
  });

  it('Worktree fills the same three slots with its own values; the layout does not change', async () => {
    const fixture = await render(WhereRow);
    const labels = () =>
      [...(fixture.nativeElement as HTMLElement).querySelectorAll('.grid .k')].map((k) => k.textContent);
    expect(labels()).toEqual(['branch', 'from', 'setup']);
    click(fixture, 'where-worktree');
    fixture.detectChanges();
    expect(labels()).toEqual(['branch', 'from', 'setup']);
    expect(text(fixture, 'where-sentence')).toBe('a fresh checkout under ~/.pi-kit/worktrees/pi-kit/');
    expect(text(fixture, 'where-branch')).toBe('pi-kit/<name>');
    expect(text(fixture, 'where-from')).toContain('main');
    expect(text(fixture, 'where-from')).toContain('carry 3 changes');
    expect(text(fixture, 'where-setup')).toBe('Node');
  });

  it('the Local branch menu disables a branch a worktree holds and the ones the changed files block, with the reasons', async () => {
    const fixture = await render(WhereRow);
    click(fixture, 'where-branch-button');
    fixture.detectChanges();
    const develop = fixture.nativeElement.querySelector('[data-testid="where-branch-develop"]') as HTMLElement;
    expect(develop.getAttribute('aria-disabled')).toBe('true');
    expect(develop.textContent).toContain('stash or commit the 3 files first');
    const held = fixture.nativeElement.querySelector('[data-testid="where-branch-pi-kit/settings-ux"]') as HTMLElement;
    expect(held.getAttribute('aria-disabled')).toBe('true');
    expect(held.textContent).toContain('held by the worktree of “Settings v2 proposal”');
    develop.click();
    fixture.detectChanges();
    expect(text(fixture, 'where-branch-button')).toBe('main');
  });

  it('a clean folder lets the branch be switched, and "New branch from main…" takes a name', async () => {
    api.projectGit.mockResolvedValue(git({ dirty: 0 }));
    const fixture = await render(WhereRow);
    click(fixture, 'where-branch-button');
    fixture.detectChanges();
    click(fixture, 'where-branch-develop');
    fixture.detectChanges();
    expect(text(fixture, 'where-branch')).toBe('develop');
    expect(text(fixture, 'where-sentence')).toContain('as it is');
    click(fixture, 'where-branch-button');
    fixture.detectChanges();
    click(fixture, 'where-new-branch');
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('[data-testid=where-new-branch-name]') as HTMLInputElement;
    input.value = 'feature/x';
    click(fixture, 'where-new-branch-make');
    fixture.detectChanges();
    expect(text(fixture, 'where-branch')).toBe('feature/x');
  });

  it('the hint under the well says what Send will do, and follows the mode', async () => {
    const row = await render(WhereRow);
    const hint = await render(WhereHint);
    expect(text(hint, 'where-hint')).toBe('Sending starts the thread in ~/Development/pi-kit on main.');
    click(row, 'where-worktree');
    hint.detectChanges();
    expect(text(hint, 'where-hint')).toBe(
      'Sending makes the worktree pi-kit/<name> from main, runs npm ci, then starts the thread in it.',
    );
  });

  it('keeps an open branch menu and a typed name through status refreshes, and clears them when the thread changes', async () => {
    const fixture = await render(WhereRow);
    fixture.autoDetectChanges();
    click(fixture, 'where-branch-button');
    await fixture.whenStable();
    const branch = fixture.nativeElement.querySelector('[data-testid="where-branch-develop"]');
    expect(branch).not.toBeNull();
    selected.update((thread) => ({ ...thread!, updatedAt: 2 }));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-testid="where-branch-develop"]')).toBe(branch);
    click(fixture, 'where-new-branch');
    await fixture.whenStable();
    const input = fixture.nativeElement.querySelector('[data-testid="where-new-branch-name"]') as HTMLInputElement;
    input.value = 'feature/keep-this';
    selected.update((thread) => ({ ...thread!, updatedAt: 3 }));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-testid="where-new-branch-name"]')).toBe(input);
    expect(input.value).toBe('feature/keep-this');
    selected.set(fakeThread('n2', { cwd: CWD, messageCount: 0, origin: 'app' }));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-testid="where-branch-menu"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="where-new-branch-name"]')).toBeNull();
  });

  it('a project that is not a repository shows only the project and its sentence', async () => {
    api.projectGit.mockResolvedValue(git({ git: false, branch: null, branches: [], remoteBranches: [], dirty: 0 }));
    workspaces.set([workspace(settings({ git: false }))]);
    const fixture = await render(WhereRow);
    expect(fixture.nativeElement.querySelector('[data-testid=where-project]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid=where-local]')).toBeNull();
    expect(fixture.nativeElement.querySelector('.grid')).toBeNull();
  });

  it('draws nothing once the thread has a message, or for a thread that is not new', async () => {
    const fixture = await render(WhereRow);
    expect(fixture.nativeElement.querySelector('[data-testid=where-row]')).not.toBeNull();
    messages.set([{}]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid=where-row]')).toBeNull();
    messages.set([]);
    selected.set(
      fakeThread('n1', {
        cwd: CWD,
        messageCount: 0,
        origin: 'app',
        worktree: { path: '/wt', branch: 'b', base: 'main', exists: true },
      }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid=where-row]')).toBeNull();
  });

  it('the first Send applies the plan through an input transform, and a refusal keeps the draft', async () => {
    const fixture = await render(WhereRow);
    expect(transforms.map((t) => t.id)).toEqual(['where']);
    click(fixture, 'where-worktree');
    fixture.detectChanges();
    const input = { text: 'Fix the row', images: [], fileRefs: [] };
    expect(await transforms[0].transform(input)).toEqual(input);
    expect(api.place).toHaveBeenCalledWith('n1', { worktree: { carryChanges: false, name: 'Fix the row' } });
    // The plan went with the first Send; a second message is none of its business.
    api.place.mockClear();
    expect(await transforms[0].transform(input)).toEqual(input);
    expect(api.place).not.toHaveBeenCalled();
  });

  it('a refused Send says why and the row stays', async () => {
    api.place.mockRejectedValueOnce(
      new Error('The folder has 3 uncommitted files. Stash or commit them, then switch to develop.'),
    );
    api.projectGit.mockResolvedValue(git({ dirty: 0 }));
    const fixture = await render(WhereRow);
    click(fixture, 'where-branch-button');
    fixture.detectChanges();
    click(fixture, 'where-branch-develop');
    fixture.detectChanges();
    const result = await transforms[0].transform({ text: 'go', images: [], fileRefs: [] });
    expect(result.refuse).toMatch(/3 uncommitted files/);
    fixture.detectChanges();
    expect(text(fixture, 'where-error')).toMatch(/3 uncommitted files/);
    expect(fixture.nativeElement.querySelector('[data-testid=where-row]')).not.toBeNull();
  });

  it('does not repeat placement for a steering message while the sidebar still reports an empty thread', async () => {
    const fixture = await render(WhereRow);
    fixture.autoDetectChanges();
    click(fixture, 'where-worktree');
    await fixture.whenStable();
    messages.set([{ role: 'user', content: 'the first prompt' }]);
    await fixture.whenStable();
    const input = { text: 'steer the running turn', images: [], fileRefs: [] };
    expect(await transforms[0].transform(input)).toEqual(input);
    expect(api.place).not.toHaveBeenCalled();
    expect(threads.refresh).not.toHaveBeenCalled();
  });

  it('Remember is a checkbox, off until ticked', async () => {
    const fixture = await render(WhereRow);
    const box = fixture.nativeElement.querySelector('[data-testid=where-remember]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.click();
    fixture.detectChanges();
    await transforms[0].transform({ text: 'go', images: [], fileRefs: [] });
    expect(threads.setWorktreeSettings).toHaveBeenCalledWith(CWD, { start: 'local' });
  });
});
