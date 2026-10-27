import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withProps, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  learnStop,
  learnedSkillsList,
  learnedSkillsRetire,
  learnedSkillsReverify,
  learnedSkillsUnretire,
  unwrap,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { LearnedSkill } from '@pi-kit/protocol';

import { ThreadShell } from './ports';
import { THREADS_POLICY } from './threads-policy';
import { ThreadsStore } from './threads.store';

interface LearnedState {
  /** `undefined` until the first read. Live and retired skills together; `retiredAt` tells them apart. */
  skills: LearnedSkill[] | undefined;
  /** The skill an action is working on, by id and what it is doing. */
  busy: Record<string, 'retiring' | 'restoring' | 'verifying' | 'saving'>;
  /** A refusal to show under a skill's row (a skill being verified cannot be retired, a name pi lists now cannot be restored). */
  errors: Record<string, string>;
}

/**
 * The record of the learned skills for Settings › Extensions and skills: provenance, uses, merged-after-use, the last verification, a flag, and the person's
 * actions on a skill: Re-verify, Retire, Restore (Edit is the review dialog's, `LearnStore.edit`). After an action that changes what pi loads, the open thread's `/` menu and chips
 * read the commands again (`ThreadShell.skillsChanged`).
 */
export const LearnedStore = signalStore(
  { providedIn: 'root' },
  withState<LearnedState>({ skills: undefined, busy: {}, errors: {} }),
  withProps(() => ({ _policy: inject(THREADS_POLICY) })),
  withComputed((store) => ({
    live: computed(() => (store.skills() ?? []).filter((s) => s.retiredAt === null)),
    retired: computed(() => (store.skills() ?? []).filter((s) => s.retiredAt !== null)),
    verifying: computed(() => (store.skills() ?? []).some((s) => s.verification?.state === 'running')),
  })),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const shell = inject(ThreadShell);
    const toasts = inject(ToastStore);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading: Promise<void> | undefined;
    const setBusy = (id: string, what: LearnedState['busy'][string] | undefined): void =>
      patchState(store, (s) => {
        const busy = { ...s.busy };
        if (what) busy[id] = what;
        else delete busy[id];
        return { busy };
      });
    const setError = (id: string, error: string | undefined): void =>
      patchState(store, (s) => {
        const errors = { ...s.errors };
        if (error) errors[id] = error;
        else delete errors[id];
        return { errors };
      });
    const replace = (skill: LearnedSkill): void =>
      patchState(store, (s) => ({ skills: (s.skills ?? []).map((k) => (k.id === skill.id ? skill : k)) }));
    /** What the open thread's `/` menu and chips list changed. */
    const skillsChanged = (): void => {
      const open = threads.selectedId();
      if (open) shell.skillsChanged(open);
    };

    const methods = {
      /** Reads the record. Calls that overlap share one request (every skill row asks when it appears). */
      load(): Promise<void> {
        loading ??= (async () => {
          try {
            patchState(store, { skills: await unwrap(learnedSkillsList({ client: api.client })) });
          } catch (error) {
            if (store.skills() === undefined) patchState(store, { skills: [] });
            toasts.show(
              'error',
              translate('threads.learnedStore.couldNotReadTheLearnedSkills', { value1: errorMessage(error) }),
            );
          } finally {
            loading = undefined;
          }
          methods.watch();
        })();
        return loading;
      },

      /** While a replay runs, the record is read again until it is over. */
      watch(): void {
        clearTimeout(timer);
        timer = undefined;
        if (!store.verifying()) return;
        timer = setTimeout(async () => {
          timer = undefined;
          const before = (store.skills() ?? []).filter((s) => s.verification?.state === 'running').map((s) => s.id);
          try {
            patchState(store, { skills: await unwrap(learnedSkillsList({ client: api.client })) });
          } catch {
            // The next round tries again.
          }
          if ((store.skills() ?? []).some((s) => before.includes(s.id) && s.verification?.state !== 'running')) {
            void threads.refresh();
            skillsChanged();
          }
          methods.watch();
        }, store._policy.learnedPollMs);
      },

      /** Retire: the folder moves to `.retired/`; pi stops loading the skill. Nothing is deleted. */
      async retire(skill: LearnedSkill): Promise<boolean> {
        setBusy(skill.id, 'retiring');
        setError(skill.id, undefined);
        try {
          replace(await unwrap(learnedSkillsRetire({ client: api.client, path: { id: skill.id } })));
          toasts.show('info', translate('threads.learnedStore.retiredPiDoesNotLoadItAny', { value1: skill.name }));
          skillsChanged();
          return true;
        } catch (error) {
          setError(skill.id, errorMessage(error));
          return false;
        } finally {
          setBusy(skill.id, undefined);
        }
      },

      async restore(skill: LearnedSkill): Promise<boolean> {
        setBusy(skill.id, 'restoring');
        setError(skill.id, undefined);
        try {
          replace(await unwrap(learnedSkillsUnretire({ client: api.client, path: { id: skill.id } })));
          toasts.show('success', translate('threads.learnedStore.restoredItIsInTheMenuAgain', { value1: skill.name }));
          skillsChanged();
          return true;
        } catch (error) {
          setError(skill.id, errorMessage(error));
          return false;
        } finally {
          setBusy(skill.id, undefined);
        }
      },

      /** Re-verify: replays the skill from the base commit of its thread; the row shows the phase until the report is in. */
      async reverify(skill: LearnedSkill): Promise<void> {
        setBusy(skill.id, 'verifying');
        setError(skill.id, undefined);
        try {
          replace(await unwrap(learnedSkillsReverify({ client: api.client, path: { id: skill.id } })));
          methods.watch();
        } catch (error) {
          setError(skill.id, errorMessage(error));
        } finally {
          setBusy(skill.id, undefined);
        }
      },

      /** Stops a running re-verification (the draft's route: a learned skill's id is its draft's). */
      async stopVerify(skill: LearnedSkill): Promise<void> {
        setError(skill.id, undefined);
        try {
          await unwrap(learnStop({ client: api.client, path: { id: skill.id } }));
          await methods.load();
        } catch (error) {
          setError(skill.id, errorMessage(error));
        }
      },

      /** A skill was saved in the dialog (or verified there): the row takes the fresh record. */
      take(skill: LearnedSkill): void {
        replace(skill);
        skillsChanged();
      },
    };
    return methods;
  }),
);
export type LearnedStore = InstanceType<typeof LearnedStore>;
