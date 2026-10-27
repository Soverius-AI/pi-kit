import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  learnApprove,
  learnDiscard,
  learnForThread,
  learnPlan,
  learnReopen,
  learnRequest,
  learnStart,
  learnStop,
  learnWorkspace,
  learnedSkillsGet,
  learnedSkillsList,
  learnedSkillsSave,
  provideMockApi,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { LearnedSkill, LearnedSkillDetail, SkillDraft, SkillVerification, VerifyPlan } from '@pi-kit/protocol';
import { thread } from '@pi-kit/testing';
import { LearnStore, ThreadShell, ThreadsStore } from '@pi-kit/threads/data';
import { SkillReviewDialog } from './skill-review-dialog';

const TEXT =
  '---\nname: add-a-migration\ndescription: Use when adding a table\nx-pi-kit:\n  learnedFrom: t1\n  base: null\n  head: null\n  verified: null\n---\n\n# Steps\n1. Do it\n';
const draft = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  id: 'd1',
  threadId: 't1',
  name: 'add-a-migration',
  text: TEXT,
  scope: 'project',
  state: 'pending',
  verification: null,
  madeBy: 'attendant',
  model: 'p/m',
  createdAt: Date.now() - 120_000,
  decidedAt: null,
  path: null,
  ...over,
});

const BASE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const plan = (over: Partial<VerifyPlan> = {}): VerifyPlan => ({
  canVerify: true,
  prompt: 'Create the notes.',
  base: BASE,
  head: 'b'.repeat(40),
  files: 6,
  checks: [{ command: 'node --test notes.test.mjs', originalPassed: true }],
  model: 'learn-fake/canned',
  busy: false,
  ...over,
});
const note = (n: number) => ({
  path: `notes/${n}.md`,
  status: 'same' as const,
  similarity: 1,
  hunks: { matched: 1, expected: 1, actual: 1 },
});
const report = (over: Partial<SkillVerification> = {}): SkillVerification => ({
  state: 'done',
  result: 'pass',
  score: 1,
  files: { reproduced: 6, expected: 6, extra: 0 },
  hunks: { matched: 6, expected: 6, actual: 6 },
  fileList: [1, 2, 3, 4, 5, 6].map(note),
  checks: [
    {
      command: 'node --test notes.test.mjs',
      originalPassed: true,
      state: 'passed',
      exitCode: 0,
      seconds: 0.4,
      output: '',
    },
  ],
  summary: 'Reproduced 6 of 6 files and 6 of 6 hunks; 1 of 1 check passes again.',
  ...over,
});

describe('SkillReviewDialog', () => {
  const api = {
    draft: vi.fn(async () => draft()),
    request: vi.fn(async () => ({ status: 'drafted' as const, draft: draft() })),
    approve: vi.fn(async (_id: string, body: { name: string }) => ({
      draft: draft({ state: 'approved', name: body.name }),
      path: '/p/.pi/skills/x/SKILL.md',
    })),
    discard: vi.fn(async () => draft({ state: 'discarded' })),
    reopen: vi.fn(async () => draft()),
    verifyPlan: vi.fn(async () => plan({ canVerify: false, reason: 'The thread has no outcome yet.' })),
    verify: vi.fn(async (): Promise<SkillDraft> => draft({ verification: { state: 'running', phase: 'worktree' } })),
    stopVerify: vi.fn(async (): Promise<SkillDraft> => draft({ verification: { state: 'stopped' } })),
  };
  const shell = { skillsChanged: vi.fn(), openOutcome: vi.fn() };
  const toasts = { show: vi.fn() };
  const learnedSkill: LearnedSkill = {
    id: 'd1',
    name: 'add-a-migration',
    scope: 'project',
    path: '/p/.pi/skills/add-a-migration/SKILL.md',
    retiredAt: null,
    missing: false,
    learnedFrom: { threadId: 't1', title: 'Add the invoices table', base: null, head: null },
    verification: null,
    uses: 3,
    mergedAfterUse: 2,
    threads: 2,
    lastUsedAt: 1,
    flag: null,
  };
  const learnedApi = {
    get: vi.fn(async (): Promise<LearnedSkillDetail> => ({
      ...learnedSkill,
      text: TEXT,
      draft: draft({ state: 'approved', path: learnedSkill.path }),
    })),
    list: vi.fn(async () => [learnedSkill]),
    save: vi.fn(async (_id: string, _text: string): Promise<LearnedSkill> => learnedSkill),
  };

  const render = async (open: () => Promise<void>) => {
    const fixture = TestBed.createComponent(SkillReviewDialog);
    await open();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  };
  const el = (fixture: { nativeElement: unknown }): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(fixture: { nativeElement: unknown }, testId: string): T | null =>
    el(fixture).querySelector<T>(`[data-testid=${testId}]`);

  beforeEach(() => {
    vi.clearAllMocks();
    api.draft.mockImplementation(async () => draft());
    api.verifyPlan.mockImplementation(async () => plan({ canVerify: false, reason: 'The thread has no outcome yet.' }));
    api.verify.mockImplementation(async () => draft({ verification: { state: 'running', phase: 'worktree' } }));
    api.stopVerify.mockImplementation(async () => draft({ verification: { state: 'stopped' } }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ThreadsStore,
          useValue: {
            selectedId: () => 't1',
            select: vi.fn(),
            refresh: vi.fn(async () => undefined),
            threads: signal([thread('t1', { title: 'Add the invoices table' })]),
          },
        },
        { provide: ThreadShell, useValue: shell },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [learnWorkspace, vi.fn(async () => ({ id: 'learning-t1' })), () => []],
          [learnForThread, api.draft, (o) => [o.path?.['id']]],
          [learnRequest, api.request, (o) => [o.path?.['id'], o.body?.['consent']]],
          [learnApprove, api.approve, (o) => [o.path?.['id'], o.body]],
          [learnDiscard, api.discard, (o) => [o.path?.['id']]],
          [learnReopen, api.reopen, (o) => [o.path?.['id']]],
          [learnPlan, api.verifyPlan, (o) => [o.path?.['id']]],
          [learnStart, api.verify, (o) => [o.path?.['id'], o.body]],
          [learnStop, api.stopVerify, (o) => [o.path?.['id']]],
          [learnedSkillsGet, learnedApi.get, (o) => [o.path?.['id']]],
          [learnedSkillsList, learnedApi.list, () => []],
          [learnedSkillsSave, learnedApi.save, (o) => [o.path?.['id'], o.body?.['text']]],
        ]),
      ],
    });
  });

  it('renders learning as an inline region without a backdrop or document-wide Escape handler', async () => {
    const fixture = TestBed.createComponent(SkillReviewDialog);
    fixture.componentRef.setInput('embedded', true);
    fixture.autoDetectChanges();
    await TestBed.inject(LearnStore).read('t1');
    await fixture.whenStable();
    expect(q(fixture, 'review-dialog')?.getAttribute('role')).toBe('region');
    expect(q(fixture, 'review-dialog')?.hasAttribute('aria-modal')).toBe(false);
    expect(el(fixture).querySelector('.pk-backdrop')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(q(fixture, 'review-dialog')).not.toBeNull();
    el(fixture).querySelector<HTMLButtonElement>('[aria-label="Back to source chat"]')?.click();
    await fixture.whenStable();
    expect(q(fixture, 'review-dialog')).toBeNull();
  });

  it('draws nothing while it is closed', () => {
    const fixture = TestBed.createComponent(SkillReviewDialog);
    fixture.detectChanges();
    expect(q(fixture, 'review-dialog')).toBeNull();
  });

  it('shows the SKILL.md in an editor with its frontmatter and provenance, the name, the scope, Verify first and where it comes from', async () => {
    const fixture = await render(() => TestBed.inject(LearnStore).read('t1'));
    expect(q(fixture, 'review-dialog')?.getAttribute('aria-label')).toBe('Review the skill');
    expect(q<HTMLTextAreaElement>(fixture, 'skill-text')?.value).toBe(TEXT);
    expect(q<HTMLTextAreaElement>(fixture, 'skill-text')?.value).toContain('x-pi-kit:');
    expect(q<HTMLInputElement>(fixture, 'skill-name')?.value).toBe('add-a-migration');
    expect(q(fixture, 'draft-state')?.textContent?.trim()).toBe('pending');
    expect(q(fixture, 'scope-project')?.getAttribute('aria-pressed')).toBe('true');
    expect(q(fixture, 'scope-project')?.textContent).toContain('.pi/skills/add-a-migration/SKILL.md');
    expect(q(fixture, 'scope-user')?.textContent).toContain('skills/add-a-migration/SKILL.md');
    expect(q<HTMLInputElement>(fixture, 'verify-switch')?.checked).toBe(true);
    const provenance = q(fixture, 'provenance')?.textContent ?? '';
    expect(provenance).toContain('Add the invoices table');
    expect(provenance).toContain('the attendant with p/m');
    expect(provenance).toContain('2 min ago');
    expect(q<HTMLButtonElement>(fixture, 'approve')?.disabled).toBe(false);
  });

  it('typing the name rewrites the name line, and a name that is not a skill name disables Approve with the reason', async () => {
    const fixture = await render(() => TestBed.inject(LearnStore).read('t1'));
    const input = q<HTMLInputElement>(fixture, 'skill-name') as HTMLInputElement;
    input.value = 'Not A Name';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(q<HTMLTextAreaElement>(fixture, 'skill-text')?.value).toContain('name: Not A Name\n');
    expect(q<HTMLButtonElement>(fixture, 'approve')?.disabled).toBe(true);
    expect(q(fixture, 'learn-problems')?.textContent).toContain('lowercase letters');
  });

  it('Approve sends the final name, scope and text, and the dialog closes with the toast', async () => {
    const store = TestBed.inject(LearnStore);
    const fixture = await render(() => store.read('t1'));
    q(fixture, 'scope-user')?.click();
    q<HTMLInputElement>(fixture, 'verify-switch')?.click();
    fixture.detectChanges();
    q(fixture, 'approve')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.approve).toHaveBeenCalledWith('d1', {
      name: 'add-a-migration',
      scope: 'user',
      text: TEXT,
      verify: false,
    });
    expect(q(fixture, 'review-dialog')).toBeNull();
    expect(shell.skillsChanged).toHaveBeenCalledWith('t1');
  });

  it('keeps the dialog open and says why when the name is taken', async () => {
    api.approve.mockRejectedValueOnce(new Error('A folder named add-a-migration already exists. Choose another name.'));
    const fixture = await render(() => TestBed.inject(LearnStore).read('t1'));
    q(fixture, 'approve')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(q(fixture, 'learn-error')?.textContent).toContain('Choose another name');
    expect(q(fixture, 'review-dialog')).not.toBeNull();
  });

  it('Discard records the decision and writes nothing', async () => {
    const fixture = await render(() => TestBed.inject(LearnStore).read('t1'));
    q(fixture, 'discard')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.discard).toHaveBeenCalledWith('d1');
    expect(api.approve).not.toHaveBeenCalled();
    expect(q(fixture, 'review-dialog')).toBeNull();
  });

  it('a discarded draft is read-only and offers to reopen it', async () => {
    api.draft.mockResolvedValueOnce(draft({ state: 'discarded' }));
    const fixture = await render(() => TestBed.inject(LearnStore).read('t1'));
    expect(q<HTMLTextAreaElement>(fixture, 'skill-text')?.readOnly).toBe(true);
    expect(q(fixture, 'approve')).toBeNull();
    q(fixture, 'reopen')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.reopen).toHaveBeenCalledWith('d1');
    expect(q(fixture, 'approve')).not.toBeNull();
  });

  it('an approved draft says where the skill was written', async () => {
    api.draft.mockResolvedValueOnce(draft({ state: 'approved', path: '/p/.pi/skills/add-a-migration/SKILL.md' }));
    const fixture = await render(() => TestBed.inject(LearnStore).read('t1'));
    expect(q(fixture, 'draft-path')?.textContent).toContain('/p/.pi/skills/add-a-migration/SKILL.md');
    expect(q(fixture, 'approve')).toBeNull();
  });

  it('asks for the person’s agreement before the transcript goes to a model while the attendant is off', async () => {
    api.request.mockResolvedValueOnce({
      status: 'consent' as never,
      draft: undefined as never,
      ...({
        model: 'llama-swap/gemma',
        message: 'This sends the thread’s transcript to llama-swap/gemma to draft a skill.',
      } as object),
    });
    const store = TestBed.inject(LearnStore);
    const fixture = await render(() => store.request('t1'));
    expect(q(fixture, 'consent-text')?.textContent).toContain('This sends the thread’s transcript to llama-swap/gemma');
    expect(api.request).toHaveBeenCalledTimes(1);
    q(fixture, 'consent-agree')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.request).toHaveBeenLastCalledWith('t1', true);
    expect(q(fixture, 'skill-text')).not.toBeNull();
  });

  describe('verification', () => {
    const open = async () => {
      const store = TestBed.inject(LearnStore);
      const fixture = await render(() => store.read('t1'));
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(store.plan()).toBeDefined();
      });
      return { store, fixture };
    };
    const settle = async (fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) => {
      await fixture.whenStable();
      fixture.detectChanges();
    };

    beforeEach(() => {
      api.verifyPlan.mockImplementation(async () => plan());
    });
    afterEach(() => vi.useRealTimers());

    it('shows the prompt the replay will send and what it is compared with, and the button says Verify first', async () => {
      const { fixture } = await open();
      expect(q<HTMLTextAreaElement>(fixture, 'verify-prompt')?.value).toBe('Create the notes.');
      expect(q(fixture, 'verify-plan')?.textContent).toContain(
        'sent from commit a1b2c3d with the skill pinned and learn-fake/canned',
      );
      expect(q(fixture, 'verify-plan')?.textContent).toContain(
        'the 6 files of the outcome; it runs the thread’s 1 check again',
      );
      expect(q(fixture, 'approve')?.textContent?.trim()).toBe('Verify first');
      expect(q(fixture, 'approve')?.getAttribute('data-step')).toBe('verify');
      expect(q(fixture, 'verification')?.getAttribute('data-state')).toBe('none');
      expect(q(fixture, 'verification-result')).toBeNull();
    });

    it('Approve with Verify first on replays the text and the prompt in the editor instead of writing, and waits while it runs', async () => {
      const { fixture } = await open();
      const prompt = q<HTMLTextAreaElement>(fixture, 'verify-prompt') as HTMLTextAreaElement;
      prompt.value = 'Create the notes. Be quick.';
      prompt.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      q(fixture, 'approve')?.click();
      await settle(fixture);
      expect(api.approve).not.toHaveBeenCalled();
      expect(api.verify).toHaveBeenCalledWith('d1', {
        name: 'add-a-migration',
        text: TEXT,
        prompt: 'Create the notes. Be quick.',
      });
      expect(q(fixture, 'verification')?.getAttribute('data-state')).toBe('running');
      expect(q(fixture, 'verification-phase')?.textContent).toContain('Making a scratch worktree at the base commit');
      expect(q(fixture, 'approve')?.textContent?.trim()).toBe('Verifying…');
      expect(q<HTMLButtonElement>(fixture, 'approve')?.disabled).toBe(true);
      expect(
        q<HTMLTextAreaElement>(fixture, 'skill-text') && q<HTMLInputElement>(fixture, 'verify-switch')?.disabled,
      ).toBe(true);
      expect(q(fixture, 'verify-stop')).not.toBeNull();

      // The dialog asks again; the replay is in its next phase, then done.
      api.draft.mockResolvedValueOnce(draft({ verification: { state: 'running', phase: 'checks' } }));
      await vi.advanceTimersByTimeAsync(1600);
      await settle(fixture);
      expect(q(fixture, 'verification-phase')?.textContent).toContain('Running the thread’s checks again');
      api.draft.mockResolvedValueOnce(
        draft({ text: TEXT.replace('verified: null', 'verified:\n    result: pass'), verification: report() }),
      );
      await vi.advanceTimersByTimeAsync(1600);
      await settle(fixture);
      expect(q(fixture, 'verification')?.getAttribute('data-state')).toBe('done');
      expect(q(fixture, 'verification-result')?.textContent?.trim()).toBe('Pass');
      expect(q(fixture, 'verification-summary')?.textContent).toContain(
        'Reproduced 6 of 6 files and 6 of 6 hunks; 1 of 1 check passes again.',
      );
      expect(q(fixture, 'verification-score')?.textContent).toContain('100 % of the changed lines match');
      expect(q(fixture, 'verification-files')?.querySelectorAll('li').length).toBe(6);
      expect(q(fixture, 'verification-checks')?.textContent).toContain('node --test notes.test.mjs');
      expect(q(fixture, 'verification-checks')?.textContent).toContain('passed in the thread');
      expect(q<HTMLTextAreaElement>(fixture, 'skill-text')?.value).toContain('result: pass');
      expect(q(fixture, 'approve')?.textContent?.trim()).toBe('Approve');
      expect(q<HTMLButtonElement>(fixture, 'approve')?.disabled).toBe(false);

      // Now Approve writes, with the text that carries the result.
      q(fixture, 'approve')?.click();
      await settle(fixture);
      expect(api.approve).toHaveBeenCalledWith(
        'd1',
        expect.objectContaining({
          name: 'add-a-migration',
          verify: true,
          text: expect.stringContaining('result: pass'),
        }),
      );
    });

    it('a partial or failed report does not block Approve: the person decides', async () => {
      api.draft.mockResolvedValue(
        draft({
          verification: report({
            result: 'partial',
            files: { reproduced: 5, expected: 6, extra: 0 },
            summary: 'Reproduced 5 of 6 files and 5 of 6 hunks.',
            fileList: [
              ...[1, 2, 3, 4, 5].map(note),
              { path: 'notes/6.md', status: 'missing', similarity: 0, hunks: { matched: 0, expected: 1, actual: 0 } },
            ],
          }),
        }),
      );
      const { fixture } = await open();
      expect(q(fixture, 'verification-result')?.textContent?.trim()).toBe('Partial');
      expect(q(fixture, 'verification-result')?.className).toContain('warn');
      expect(q(fixture, 'verification-files')?.querySelector('[data-status=missing] .path')?.textContent).toBe(
        'notes/6.md',
      );
      expect(q(fixture, 'approve')?.textContent?.trim()).toBe('Approve');
      expect(q<HTMLButtonElement>(fixture, 'approve')?.disabled).toBe(false);
      api.draft.mockResolvedValue(draft({ verification: report({ result: 'failed' }) }));
      const second = await open();
      expect(q(second.fixture, 'verification-result')?.className).toContain('err');
      expect(q<HTMLButtonElement>(second.fixture, 'approve')?.disabled).toBe(false);
    });

    it('an edit makes the report stale: the chip says so and the button replays again', async () => {
      api.draft.mockResolvedValue(draft({ verification: report() }));
      const { fixture } = await open();
      expect(q(fixture, 'verification-stale')).toBeNull();
      const text = q<HTMLTextAreaElement>(fixture, 'skill-text') as HTMLTextAreaElement;
      text.value = TEXT.replace('1. Do it', '1. Do it twice');
      text.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(q(fixture, 'verification-stale')?.textContent).toContain('Edited since');
      expect(q(fixture, 'verification-stale-note')?.textContent).toContain('report is for the earlier text');
      expect(q(fixture, 'approve')?.textContent?.trim()).toBe('Verify again');
    });

    it('Stop asks the server to stop the replay', async () => {
      api.draft.mockResolvedValue(draft({ verification: { state: 'running', phase: 'run' } }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { fixture } = await open();
      q(fixture, 'verify-stop')?.click();
      await settle(fixture);
      expect(api.stopVerify).toHaveBeenCalledWith('d1');
      expect(q(fixture, 'verification-stopped')?.textContent).toContain('stopped');
    });

    it('says why a replay could not be carried out, and offers it again', async () => {
      api.draft.mockResolvedValue(
        draft({ verification: { state: 'error', error: 'The project has pi resources that are not trusted yet.' } }),
      );
      const { fixture } = await open();
      expect(q(fixture, 'verification-error')?.textContent).toContain('not trusted yet');
      expect(q(fixture, 'verification-result')?.textContent?.trim()).toBe('Could not verify');
      expect(q(fixture, 'approve')?.textContent?.trim()).toBe('Verify again');
    });

    it('a draft that cannot be replayed says why, and Approve goes ahead', async () => {
      api.verifyPlan.mockImplementation(async () =>
        plan({ canVerify: false, reason: 'The thread has no outcome yet.' }),
      );
      const { fixture } = await open();
      expect(q(fixture, 'verify-reason')?.textContent).toContain(
        'Cannot be verified now: The thread has no outcome yet.',
      );
      expect(q(fixture, 'step-note')?.textContent).toContain('Cannot verify first');
      expect(q(fixture, 'approve')?.textContent?.trim()).toBe('Approve');
      expect(q(fixture, 'verify-run')).toBeNull();
    });

    it('with Verify first off, Approve writes at once; Verify now still replays', async () => {
      const { fixture } = await open();
      q<HTMLInputElement>(fixture, 'verify-switch')?.click();
      fixture.detectChanges();
      expect(q(fixture, 'approve')?.textContent?.trim()).toBe('Approve');
      expect(q(fixture, 'verify-run')?.textContent?.trim()).toBe('Verify now');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      q(fixture, 'verify-run')?.click();
      await settle(fixture);
      expect(api.verify).toHaveBeenCalledTimes(1);
      expect(api.approve).not.toHaveBeenCalled();
    });

    it('a discarded draft has no verification section, and an approved one can be verified again without editing', async () => {
      api.draft.mockResolvedValueOnce(draft({ state: 'discarded' }));
      const discarded = await open();
      expect(q(discarded.fixture, 'verification')).toBeNull();
      api.draft.mockResolvedValue(
        draft({ state: 'approved', path: '/p/.pi/skills/add-a-migration/SKILL.md', verification: report() }),
      );
      const approved = await open();
      expect(q(approved.fixture, 'verification-result')?.textContent?.trim()).toBe('Pass');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      q(approved.fixture, 'verify-run')?.click();
      await settle(approved.fixture);
      expect(api.verify).toHaveBeenCalledWith('d1', {});
    });

    it('a long list of files is cut and the rest counted', async () => {
      const many = Array.from({ length: 15 }, (_, i) => note(i + 1));
      api.draft.mockResolvedValue(
        draft({ verification: report({ fileList: many, files: { reproduced: 15, expected: 15, extra: 0 } }) }),
      );
      const { fixture } = await open();
      expect(q(fixture, 'verification-files')?.querySelectorAll('li').length).toBe(12);
      expect(el(fixture).textContent).toContain('and 3 more');
    });
  });

  it('Esc closes it from anywhere on the page: the focus can be gone with the control that had it', async () => {
    const store = TestBed.inject(LearnStore);
    const fixture = await render(() => store.read('t1'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(store.dialog()).toBeUndefined();
    // Closed already: another Esc is nobody's business here.
    const other = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it('Esc closes it', async () => {
    const store = TestBed.inject(LearnStore);
    const fixture = await render(() => store.read('t1'));
    q(fixture, 'review-dialog')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(store.dialog()).toBeUndefined();
  });
  describe('editing an approved skill', () => {
    const EDITED = TEXT.replace('1. Do it', '1. Do it twice');
    const type = (fixture: { detectChanges: () => void }, area: HTMLTextAreaElement, text: string): void => {
      area.value = text;
      area.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };

    it('shows the saved text in an editor you can type in, the name fixed, and Cancel and Save in place of Approve and Discard', async () => {
      const fixture = await render(() => TestBed.inject(LearnStore).edit(learnedSkill));
      expect(q(fixture, 'review-dialog')?.getAttribute('aria-label')).toBe('Edit the skill');
      expect(q(fixture, 'draft-state')?.textContent?.trim()).toBe('approved');
      const area = q<HTMLTextAreaElement>(fixture, 'skill-text') as HTMLTextAreaElement;
      expect(area.value).toBe(TEXT);
      expect(area.readOnly).toBe(false);
      expect(q<HTMLInputElement>(fixture, 'skill-name')?.readOnly).toBe(true);
      expect(q(fixture, 'approve')).toBeNull();
      expect(q(fixture, 'discard')).toBeNull();
      expect(q(fixture, 'verify-switch')).toBeNull();
      expect(q<HTMLButtonElement>(fixture, 'edit-save')?.disabled).toBe(true);
      expect(q(fixture, 'provenance')?.textContent).toContain('Add the invoices table');
      expect(el(fixture).textContent).toContain('stamped again when you save');
    });

    it('Save is enabled by a change, refused for a text pi would not load, and writes the text', async () => {
      const fixture = await render(() => TestBed.inject(LearnStore).edit(learnedSkill));
      const area = q<HTMLTextAreaElement>(fixture, 'skill-text') as HTMLTextAreaElement;
      type(fixture, area, EDITED);
      expect(q<HTMLButtonElement>(fixture, 'edit-save')?.disabled).toBe(false);
      type(fixture, area, 'just words');
      expect(q<HTMLButtonElement>(fixture, 'edit-save')?.disabled).toBe(true);
      expect(q(fixture, 'learn-problems')?.textContent).toContain('frontmatter');
      type(fixture, area, EDITED);
      q(fixture, 'edit-save')?.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(learnedApi.save).toHaveBeenCalledWith('d1', EDITED);
      expect(q(fixture, 'review-dialog')).toBeNull();
    });

    it('Cancel leaves the file alone', async () => {
      const store = TestBed.inject(LearnStore);
      const fixture = await render(() => store.edit(learnedSkill));
      type(fixture, q<HTMLTextAreaElement>(fixture, 'skill-text') as HTMLTextAreaElement, EDITED);
      q(fixture, 'edit-cancel')?.click();
      fixture.detectChanges();
      expect(learnedApi.save).not.toHaveBeenCalled();
      expect(store.dialog()).toBeUndefined();
    });

    it('Verify again replays the saved skill, and with an unsaved edit says to save first', async () => {
      api.verifyPlan.mockImplementation(async () => plan());
      learnedApi.get.mockImplementation(async () => ({
        ...learnedSkill,
        text: TEXT,
        draft: draft({ state: 'approved', path: learnedSkill.path, verification: report() }),
      }));
      const fixture = await render(() => TestBed.inject(LearnStore).edit(learnedSkill));
      expect(q(fixture, 'verification-result')?.textContent?.trim()).toBe('Pass');
      type(fixture, q<HTMLTextAreaElement>(fixture, 'skill-text') as HTMLTextAreaElement, EDITED);
      expect(q(fixture, 'verification-stale')).not.toBeNull();
      q(fixture, 'verify-run')?.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(api.verify).not.toHaveBeenCalled();
      expect(q(fixture, 'learn-error')?.textContent).toContain('Save your edit first');
    });

    it('names a thread that was deleted', async () => {
      const gone = { ...learnedSkill, learnedFrom: { threadId: 't-gone', title: null, base: null, head: null } };
      const fixture = await render(() => TestBed.inject(LearnStore).edit(gone));
      expect(q(fixture, 'provenance')?.textContent).toContain('a thread that was deleted');
    });
  });
});
