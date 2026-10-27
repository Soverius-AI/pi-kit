import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withProps,
  withState,
  getState,
} from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
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
  learnedSkillsSave,
  unwrap,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import {
  type LearnedSkill,
  type SkillDraft,
  type SkillScope,
  type StartVerify,
  type ThreadSummary,
  type VerifyPlan,
  parseSkillText,
  setSkillName,
} from '@pi-kit/protocol';
import { learnMenuEntry, primaryStep, reviewProblems } from '@pi-kit/threads/util';

import { LearnedStore } from './learned.store';
import { OutcomeMenuStore } from './outcome-menu.store';
import { ThreadShell } from './ports';
import { THREADS_POLICY } from './threads-policy';
import { ThreadsStore } from './threads.store';

/** The source chat's learning review: a draft being made, the sentence to agree to, the draft to read, or a failure. */
export type LearnView = 'working' | 'consent' | 'review';

interface LearnState {
  dialog: { threadId: string; view: LearnView } | undefined;
  /** `consent`: the model the transcript would go to and the sentence the person agrees to (the attendant is off). */
  consent: { model: string; message: string } | undefined;
  draft: SkillDraft | undefined;
  /** The skill text in the editor, frontmatter included; the name is its `name:` line. */
  text: string;
  scope: SkillScope;
  /** "Verify first": on by default. With it on, the primary button replays the skill from the thread's base commit before it approves. */
  verify: boolean;
  /** What a verification would do (the prompt, the commit, the checks), once the server said; `undefined` until then. */
  plan: VerifyPlan | undefined;
  /** The first prompt the replay sends: the thread's, unless the person edited it. */
  prompt: string;
  promptEdited: boolean;
  busy: 'loading' | 'approving' | 'discarding' | 'reopening' | 'starting' | 'saving' | undefined;
  /** The dialog edits an approved skill (Settings › Extensions and skills › Edit): `id` is the learned skill's, `title` the thread it came from (null once that is gone). */
  editOf: { id: string; title: string | null } | undefined;
  /** The skill file's text when the edit dialog opened, to tell whether there is anything to save. */
  original: string;
  /** A refusal to show in the dialog (a name that is taken, a text pi would not load, a failed model call). */
  error: string | undefined;
}

const initial: LearnState = {
  dialog: undefined,
  consent: undefined,
  draft: undefined,
  text: '',
  scope: 'project',
  verify: true,
  plan: undefined,
  prompt: '',
  promptEdited: false,
  busy: undefined,
  editOf: undefined,
  original: '',
  error: undefined,
};

/**
 * Skills learned from finished threads, as the renderer knows them. A draft is made by the attendant after an outcome (the thread state carries it:
 * `state.draft` for the card and the thread menu, a `learn` suggestion for the sidebar chip) or on request (the thread menu, the outcome badge's menu, `/learn`). *Read* opens the
 * learning workspace: the `SKILL.md` as pi will load it, editable, the scope, "Verify first"; **Approve** writes the folder, **Discard** records the decision. The dialog component is a
 * lazy chunk; this store is small and stays. It adds "Learn a skill from this thread" to the outcome badge's menu (`OutcomeMenuStore.extend`).
 */
export const LearnStore = signalStore(
  { providedIn: 'root' },
  withState<LearnState>(initial),
  withProps(() => ({ _policy: inject(THREADS_POLICY) })),
  withComputed((store) => {
    const name = computed(() => parseSkillText(store.text()).name ?? '');
    return {
      open: computed(() => store.dialog() !== undefined),
      name,
      problems: computed(() => reviewProblems(store.text())),
      pending: computed(() => store.draft()?.state === 'pending'),
      /** The dialog edits an approved skill rather than reviewing a draft. */
      editing: computed(() => store.editOf() !== undefined),
      dirty: computed(() => store.editOf() !== undefined && store.text() !== store.original()),
      /** The record of the draft's last verification. */
      verification: computed(() => store.draft()?.verification ?? null),
    };
  }),
  withComputed((store) => {
    const running = computed(() => store.verification()?.state === 'running');
    // The report is for the text that was replayed; an edit afterwards makes it stale.
    const stale = computed(
      () =>
        store.verification()?.state === 'done' && store.draft() !== undefined && store.text() !== store.draft()?.text,
    );
    return {
      running,
      stale,
      canSave: computed(
        () =>
          store.editOf() !== undefined &&
          store.text() !== store.original() &&
          store.busy() === undefined &&
          store.problems().length === 0 &&
          store.verification()?.state !== 'running',
      ),
      canApprove: computed(() => store.pending() && store.busy() === undefined && store.problems().length === 0),
      /** The text can be typed in: a draft being reviewed, or an approved skill being edited. */
      editable: computed(() => store.draft()?.state === 'pending' || store.editOf() !== undefined),
    };
  }),
  withComputed((store) => {
    const translate = inject(Language).t;
    const step = computed(() =>
      primaryStep(translate, {
        verify: store.verify(),
        verification: store.verification(),
        stale: store.stale(),
        plan: store.plan(),
      }),
    );
    return {
      /** What the primary button does now: replay first, approve, or wait for a replay. */
      step,
      canPrimary: computed(() => store.canApprove() && step().action !== 'wait'),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const shell = inject(ThreadShell);
    const toasts = inject(ToastStore);
    const learned = inject(LearnedStore);

    const reviews = new Map<string, LearnState>();
    const rememberReview = (): void => {
      const state = getState(store);
      if (state.dialog?.view === 'review' && state.draft && !state.editOf)
        reviews.set(state.dialog.threadId, { ...state });
    };
    const owns = (threadId: string): boolean => store.dialog()?.threadId === threadId;
    const updateWorkspace = (threadId: string, patch: Partial<LearnState>): void => {
      if (owns(threadId)) patchState(store, patch);
      else {
        const cached = reviews.get(threadId);
        if (cached) reviews.set(threadId, { ...cached, ...patch });
      }
    };
    const selectedSource = (): string | undefined =>
      threads.threads().find((t) => t.id === threads.selectedId())?.learning?.sourceThreadId;
    const openWorkspace = async (threadId: string): Promise<void> => {
      if (selectedSource() === threadId) return;
      const selected = threads.selectedId();
      const workspace = await unwrap(learnWorkspace({ client: api.client, path: { id: threadId } }));
      await threads.refresh();
      // Creating a workspace must not steal focus after the person has switched chats.
      if (owns(threadId) && threads.selectedId() === selected) threads.select(workspace.id);
    };
    const leaveWorkspace = (threadId: string | undefined): void => {
      if (threadId && selectedSource() === threadId) threads.select(threadId);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopPolling = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };
    const fail = (error: unknown): void => patchState(store, { busy: undefined, error: errorMessage(error) });

    /** Asks for the report while a replay runs; when it is over, the editor takes the text with the `verified` entry the server put in. */
    const poll = (threadId: string): void => {
      stopPolling();
      timer = setTimeout(async () => {
        timer = undefined;
        if (store.dialog()?.threadId !== threadId) return;
        try {
          const editing = store.editOf();
          const fresh = editing
            ? (await unwrap(learnedSkillsGet({ client: api.client, path: { id: editing.id } }))).draft
            : await unwrap(learnForThread({ client: api.client, path: { id: threadId } }));
          if (store.dialog()?.threadId !== threadId) return;
          patchState(
            store,
            fresh.verification?.state === 'running'
              ? { draft: fresh }
              : { draft: fresh, text: fresh.text, ...(editing ? { original: fresh.text } : {}), busy: undefined },
          );
          if (editing && fresh.verification?.state !== 'running') void learned.load();
          if (fresh.verification?.state !== 'running') void threads.refresh();
        } catch (error) {
          if (owns(threadId)) patchState(store, { error: errorMessage(error) });
        }
        if (store.dialog()?.threadId === threadId && store.draft()?.verification?.state === 'running') poll(threadId);
      }, store._policy.learnPollMs);
    };

    /** The prompt and the checks of a verification, for the dialog to show; the dialog works without them (a draft that cannot be replayed says why when the person tries). */
    const loadPlan = async (draftId: string, threadId: string): Promise<void> => {
      try {
        const plan = await unwrap(learnPlan({ client: api.client, path: { id: draftId } }));
        if (store.dialog()?.threadId !== threadId) return;
        patchState(store, { plan, ...(store.promptEdited() ? {} : { prompt: plan.prompt }) });
      } catch {
        // No plan: Approve then goes ahead without a replay.
      }
    };

    const show = (draft: SkillDraft, threadId: string): void => {
      patchState(store, {
        dialog: { threadId, view: 'review' },
        consent: undefined,
        draft,
        text: draft.text,
        scope: draft.scope,
        verify: true,
        plan: undefined,
        prompt: '',
        promptEdited: false,
        busy: undefined,
        error: undefined,
      });
      void loadPlan(draft.id, threadId);
      if (draft.verification?.state === 'running') poll(threadId);
    };

    const methods = {
      /** Opens the review dialog on the thread's draft. */
      async read(threadId: string): Promise<void> {
        rememberReview();
        stopPolling();
        patchState(store, { ...initial, dialog: { threadId, view: 'review' }, busy: 'loading' });
        try {
          await openWorkspace(threadId);
          const draft = await unwrap(learnForThread({ client: api.client, path: { id: threadId } }));
          if (owns(threadId)) show(draft, threadId);
        } catch (error) {
          if (owns(threadId)) fail(error);
        }
      },

      /**
       * Opens the dialog on an approved skill to edit it (Settings › Extensions and skills): the file as it is on disk, the verification box to replay it, and **Save**, which writes the file
       * (the server stamps the provenance again). The name and the place stay.
       */
      async edit(skill: LearnedSkill): Promise<void> {
        rememberReview();
        stopPolling();
        const threadId = skill.learnedFrom.threadId;
        patchState(store, {
          ...initial,
          dialog: { threadId, view: 'review' },
          editOf: { id: skill.id, title: skill.learnedFrom.title },
          busy: 'loading',
        });
        try {
          const detail = await unwrap(learnedSkillsGet({ client: api.client, path: { id: skill.id } }));
          if (store.dialog()?.threadId !== threadId) return;
          patchState(store, {
            dialog: { threadId, view: 'review' },
            draft: detail.draft,
            text: detail.text,
            original: detail.text,
            scope: detail.scope,
            verify: false,
            plan: undefined,
            prompt: '',
            promptEdited: false,
            busy: undefined,
            error: undefined,
            editOf: { id: skill.id, title: skill.learnedFrom.title },
          });
          void loadPlan(detail.draft.id, threadId);
          if (detail.draft.verification?.state === 'running') poll(threadId);
        } catch (error) {
          if (store.editOf()?.id === skill.id || (owns(threadId) && store.busy() === 'loading')) fail(error);
        }
      },

      /** Save, in the edit dialog: the text is written over the skill's file and open sessions read it again. */
      async save(): Promise<void> {
        const editing = store.editOf();
        if (!editing || !store.canSave()) return;
        patchState(store, { busy: 'saving', error: undefined });
        try {
          const saved = await unwrap(
            learnedSkillsSave({ client: api.client, path: { id: editing.id }, body: { text: store.text() } }),
          );
          if (store.editOf()?.id === editing.id) {
            stopPolling();
            patchState(store, initial);
          }
          learned.take(saved);
          toasts.show('success', translate('threads.learnStore.savedOpenThreadsReadItNow', { value1: saved.name }));
          await threads.refresh();
        } catch (error) {
          if (store.editOf()?.id === editing.id) fail(error);
        }
      },

      /** Asks for a draft of the thread (the attendant's model reads it; with the attendant off, the person agrees to that first). */
      async request(threadId: string, consent?: boolean): Promise<void> {
        rememberReview();
        stopPolling();
        patchState(store, { ...initial, dialog: { threadId, view: 'working' } });
        try {
          await openWorkspace(threadId);
          const result = await unwrap(
            learnRequest({
              client: api.client,
              path: { id: threadId },
              body: consent === undefined ? {} : { consent },
            }),
          );
          // The person closed the dialog while the model worked: the draft waits on the card at the end of the thread.
          if (store.dialog()?.threadId !== threadId) {
            if (result.draft)
              toasts.show(
                'info',
                translate('threads.learnStore.draftedReadItFromTheCardAt', { value1: result.draft.name }),
              );
            return;
          }
          if (result.status === 'consent') {
            patchState(store, {
              dialog: { threadId, view: 'consent' },
              consent: {
                model: result.model ?? translate('threads.learnStore.theAttendantSModel'),
                message: result.message ?? '',
              },
            });
          } else if (result.draft) {
            show(result.draft, threadId);
          }
        } catch (error) {
          if (owns(threadId)) fail(error);
          else
            toasts.show(
              'error',
              translate('threads.learnStore.couldNotDraftTheSkill', { value1: errorMessage(error) }),
            );
        }
      },

      /** The person agreed to send the thread’s transcript to the model. */
      agree(): Promise<void> {
        const threadId = store.dialog()?.threadId;
        return threadId ? methods.request(threadId, true) : Promise.resolve();
      },

      /** What the thread menus do: ask for a draft, read the pending one, or reopen the discarded one. */
      async learnFrom(thread: ThreadSummary): Promise<void> {
        const entry = learnMenuEntry(translate, thread.state.draft, thread.messageCount);
        if (entry.disabled) return;
        if (entry.action === 'draft') return methods.request(thread.id);
        if (entry.action === 'read') return methods.read(thread.id);
        if (entry.action === 'reopen' && thread.state.draft) {
          try {
            await unwrap(learnReopen({ client: api.client, path: { id: thread.state.draft.id } }));
          } catch (error) {
            toasts.show(
              'error',
              translate('threads.learnStore.couldNotReopenTheDraft', { value1: errorMessage(error) }),
            );
            return;
          }
          return methods.read(thread.id);
        }
      },

      /** Reopening a sidebar learning chat restores an editor or attaches to the same background draft request. */
      resume(threadId: string): void {
        if (owns(threadId) && !store.editing()) return;
        rememberReview();
        stopPolling();
        const cached = reviews.get(threadId);
        if (cached) {
          patchState(store, cached);
          if (cached.draft?.verification?.state === 'running') poll(threadId);
        } else void methods.request(threadId);
      },

      close(): void {
        const source = store.dialog()?.threadId;
        rememberReview();
        stopPolling();
        patchState(store, initial);
        leaveWorkspace(source);
      },

      setText(text: string): void {
        patchState(store, { text, error: undefined });
      },
      /** The name field writes the text's `name:` line, so the text stays the one thing that is saved. */
      setName(name: string): void {
        patchState(store, { text: setSkillName(store.text(), name), error: undefined });
      },
      setScope(scope: SkillScope): void {
        patchState(store, { scope });
      },
      setVerify(verify: boolean): void {
        patchState(store, { verify });
      },
      setPrompt(prompt: string): void {
        patchState(store, { prompt, promptEdited: true });
      },

      /** The primary button: with "Verify first" on and no report for this text, replay the skill; otherwise approve. */
      async primary(): Promise<void> {
        if (!store.canPrimary()) return;
        if (store.step().action === 'verify') return methods.runVerify();
        return methods.approve();
      },

      /** Replays the draft from the thread's base commit in a scratch directory of its own. The text in the editor is what is replayed; the report appears in the dialog when it is done. */
      async runVerify(): Promise<void> {
        const draft = store.draft();
        const threadId = store.dialog()?.threadId;
        if (!draft || !threadId || store.busy() !== undefined || store.running()) return;
        if (store.dirty()) {
          patchState(store, { error: translate('threads.learnStore.saveYourEditFirstAReplayUses') });
          return;
        }
        patchState(store, { busy: 'starting', error: undefined });
        try {
          const body: StartVerify = {
            ...(draft.state === 'pending' ? { name: store.name().trim(), text: store.text() } : {}),
            ...(store.promptEdited() && store.prompt().trim() ? { prompt: store.prompt() } : {}),
          };
          const started = await unwrap(learnStart({ client: api.client, path: { id: draft.id }, body }));
          updateWorkspace(threadId, { draft: started, text: started.text, busy: undefined });
          if (owns(threadId)) poll(threadId);
        } catch (error) {
          updateWorkspace(threadId, { busy: undefined, error: errorMessage(error) });
        }
      },

      /** Stops the replay; it ends as stopped and its scratch directory is removed. */
      async stopVerify(): Promise<void> {
        const draft = store.draft();
        if (!draft || !store.running()) return;
        try {
          const stopped = await unwrap(learnStop({ client: api.client, path: { id: draft.id } }));
          if (store.draft()?.id === draft.id) patchState(store, { draft: stopped });
        } catch (error) {
          if (store.draft()?.id === draft?.id) fail(error);
        }
      },

      /** Approve: writes the skill folder. A taken name or a text pi would not load stays in the dialog, with the reason, so the person can change it. */
      async approve(): Promise<void> {
        const draft = store.draft();
        const threadId = store.dialog()?.threadId;
        if (!draft || !threadId || !store.canApprove()) return;
        patchState(store, { busy: 'approving', error: undefined });
        try {
          const approved = await unwrap(
            learnApprove({
              client: api.client,
              path: { id: draft.id },
              body: { name: store.name().trim(), scope: store.scope(), text: store.text(), verify: store.verify() },
            }),
          );
          reviews.delete(threadId);
          if (owns(threadId)) {
            stopPolling();
            patchState(store, initial);
            leaveWorkspace(threadId);
          }
          toasts.show(
            'success',
            translate('threads.learnStore.learnedItIsInTheMenuNow', { value1: approved.draft.name }),
          );
          shell.skillsChanged(threadId);
          await threads.refresh();
        } catch (error) {
          if (threadId) updateWorkspace(threadId, { busy: undefined, error: errorMessage(error) });
        }
      },

      /** Discard: records the decision and writes nothing; the thread is not drafted again. */
      async discard(): Promise<void> {
        const draft = store.draft();
        if (!draft || store.busy() !== undefined) return;
        const threadId = store.dialog()?.threadId;
        patchState(store, { busy: 'discarding', error: undefined });
        try {
          await unwrap(learnDiscard({ client: api.client, path: { id: draft.id } }));
          if (threadId) reviews.delete(threadId);
          if (threadId && owns(threadId)) {
            stopPolling();
            patchState(store, initial);
            leaveWorkspace(threadId);
          }
          toasts.show('info', translate('threads.learnStore.discardedNothingWasWrittenYouCanReopen'));
          await threads.refresh();
        } catch (error) {
          if (threadId) updateWorkspace(threadId, { busy: undefined, error: errorMessage(error) });
        }
      },

      /** A discarded draft, read in the dialog, opens again. */
      async reopen(): Promise<void> {
        const draft = store.draft();
        const threadId = store.dialog()?.threadId;
        if (!draft || !threadId || store.busy() !== undefined) return;
        patchState(store, { busy: 'reopening', error: undefined });
        try {
          const reopened = await unwrap(learnReopen({ client: api.client, path: { id: draft.id } }));
          reviews.delete(threadId);
          if (owns(threadId)) show(reopened, threadId);
        } catch (error) {
          if (threadId) updateWorkspace(threadId, { busy: undefined, error: errorMessage(error) });
        }
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      const translate = inject(Language).t;
      // "Learn a skill from this thread" in the outcome badge's menu (the extension point).
      inject(OutcomeMenuStore).extend({
        items: (thread) => {
          const entry = learnMenuEntry(translate, thread.state.draft, thread.messageCount);
          return entry.action === 'learned'
            ? []
            : [{ id: `learn:${entry.action}`, label: entry.label, disabled: entry.disabled, separatorBefore: true }];
        },
        run: (_itemId, thread) => store.learnFrom(thread),
      });
    },
  }),
);
export type LearnStore = InstanceType<typeof LearnStore>;
