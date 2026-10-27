import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  packagesDetail,
  packagesEnabled,
  packagesInstall,
  packagesList,
  packagesOutdated,
  packagesRemove,
  packagesSearch,
  packagesUpdate,
  skillsCreate,
  skillsRead,
  skillsSave,
  unwrap,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type {
  InstallPackage,
  NewSkill,
  PackageDetail,
  PackageSearchKind,
  PackageSearchResponse,
  PackagesOverview,
  SkillFile,
  SkillFilePut,
} from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';

import { SettingsStore } from './settings.store';

interface PackagesState {
  overview: PackagesOverview | undefined;
  /** The first read is in flight. */
  loading: boolean;
  /** “Check for updates” is asking pi and the registry. */
  checking: boolean;
  /** Ids of packages with an action in flight; `'+'` while an install runs. */
  busy: ReadonlySet<string>;
  /** The “Add a package” wizard is open. */
  wizard: boolean;
  /** The editor dialog is open on this skill file (the “+” of Your skills, or Edit on a skill). */
  skillEditor: { path: string; created?: boolean } | undefined;
  /** Why the list could not be read. */
  error: string | undefined;
}

/**
 * Packages and your own skills in Settings › Extensions and Settings › Skills: the installed packages with what each brings, the actions (install, update, remove, on/off,
 * check for updates), the wizard's search and detail, and the new-skill file. The backend does the work through pi's package manager; what changes here is read by the open
 * threads at their next reload, which the backend triggers for installs, updates and removals, and which the banner of Settings offers for the rest. The resource list (`SettingsStore`)
 * is read again after every change, because a package brings extensions, skills and prompts into it.
 */
export const PackagesStore = signalStore(
  { providedIn: 'root' },
  withState<PackagesState>({
    overview: undefined,
    loading: false,
    checking: false,
    busy: new Set<string>(),
    wizard: false,
    skillEditor: undefined,
    error: undefined,
  }),
  withComputed(({ overview }) => ({
    packages: computed(() => overview()?.packages ?? []),
    updates: computed(() => (overview()?.packages ?? []).filter((p) => p.outdated).length),
  })),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const settings = inject(SettingsStore);
    const toasts = inject(ToastStore);

    const cwd = (): string | undefined => threads.selected()?.cwd ?? threads.workspace();
    const setBusy = (id: string, on: boolean): void =>
      patchState(store, (s) => {
        const next = new Set(s.busy);
        if (on) next.add(id);
        else next.delete(id);
        return { busy: next };
      });
    /** What changed also changes the resources pi lists (a package brings extensions, skills, prompts). */
    const resourcesChanged = (): void => void settings.loadResources();

    const methods = {
      cwd,

      async load(): Promise<void> {
        if (!store.overview()) patchState(store, { loading: true });
        try {
          patchState(store, {
            overview: await unwrap(packagesList({ client: api.client, query: { cwd: cwd() || undefined } })),
            error: undefined,
          });
        } catch (error) {
          patchState(store, { error: errorMessage(error) });
        } finally {
          patchState(store, { loading: false });
        }
      },

      async checkForUpdates(): Promise<void> {
        patchState(store, { checking: true });
        try {
          const overview = await unwrap(packagesOutdated({ client: api.client, query: { cwd: cwd() || undefined } }));
          patchState(store, { overview });
          const n = overview.packages.filter((p) => p.outdated).length;
          toasts.show(
            'info',
            n === 0
              ? translate('settings.packagesStore.everyInstalledPackageIsCurrent')
              : translate('settings.packagesStore.anUpdate', {
                  value1: n,
                  value2:
                    n === 1
                      ? translate('settings.packagesStore.packageHas')
                      : translate('settings.packagesStore.packagesHave'),
                }),
            3500,
          );
        } catch (error) {
          toasts.show(
            'error',
            translate('settings.packagesStore.couldNotCheckForUpdates', { value1: errorMessage(error) }),
          );
        } finally {
          patchState(store, { checking: false });
        }
      },

      /** The wizard's Install: true when it went through, otherwise the sentence to show in the wizard. */
      async install(body: InstallPackage): Promise<{ ok: true } | { ok: false; error: string }> {
        setBusy('+', true);
        try {
          const result = await unwrap(
            packagesInstall({ client: api.client, query: { cwd: cwd() || undefined }, body }),
          );
          patchState(store, { overview: result.overview, wizard: false });
          toasts.show('success', result.message, 4000);
          resourcesChanged();
          return { ok: true };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        } finally {
          setBusy('+', false);
        }
      },

      async update(id: string): Promise<void> {
        setBusy(id, true);
        try {
          const result = await unwrap(
            packagesUpdate({ client: api.client, path: { id }, query: { cwd: cwd() || undefined } }),
          );
          patchState(store, { overview: result.overview });
          toasts.show('success', result.message, 4000);
          resourcesChanged();
        } catch (error) {
          toasts.show('error', errorMessage(error));
        } finally {
          setBusy(id, false);
        }
      },

      async remove(id: string): Promise<void> {
        setBusy(id, true);
        try {
          const result = await unwrap(
            packagesRemove({ client: api.client, path: { id }, query: { cwd: cwd() || undefined } }),
          );
          patchState(store, { overview: result.overview });
          toasts.show('success', result.message, 4000);
          resourcesChanged();
        } catch (error) {
          toasts.show('error', errorMessage(error));
        } finally {
          setBusy(id, false);
        }
      },

      async setEnabled(id: string, enabled: boolean): Promise<void> {
        setBusy(id, true);
        try {
          patchState(store, {
            overview: await unwrap(
              packagesEnabled({
                client: api.client,
                path: { id },
                query: { cwd: cwd() || undefined },
                body: { enabled },
              }),
            ),
          });
          settings.markReload(translate('settings.packagesStore.extensionsAndSkills'));
          resourcesChanged();
        } catch (error) {
          toasts.show('error', errorMessage(error));
          void methods.load();
        } finally {
          setBusy(id, false);
        }
      },

      openWizard(): void {
        patchState(store, { wizard: true });
      },
      closeWizard(): void {
        patchState(store, { wizard: false });
      },

      search(q: string, kind: PackageSearchKind): Promise<PackageSearchResponse> {
        return unwrap(
          packagesSearch({ client: api.client, query: { q: q || undefined, kind, cwd: cwd() || undefined } }),
        );
      },
      detail(source: string): Promise<PackageDetail> {
        return unwrap(packagesDetail({ client: api.client, query: { source, cwd: cwd() || undefined } }));
      },

      // ---- your own skills

      /** “+” on Your skills: the folder is made from the template and the editor opens on its file. */
      async newSkill(body: NewSkill): Promise<{ ok: true; file: SkillFile } | { ok: false; error: string }> {
        try {
          const file = await unwrap(skillsCreate({ client: api.client, query: { cwd: cwd() || undefined }, body }));
          patchState(store, { skillEditor: { path: file.path, created: true } });
          settings.markReload(translate('settings.packagesStore.extensionsAndSkills'));
          resourcesChanged();
          return { ok: true, file };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
      openSkillEditor(path: string): void {
        patchState(store, { skillEditor: { path } });
      },
      closeSkillEditor(): void {
        patchState(store, { skillEditor: undefined });
      },
      skillFile: (path: string): Promise<SkillFile> =>
        unwrap(skillsRead({ client: api.client, query: { path, cwd: cwd() || undefined } })),
      async saveSkill(path: string, body: SkillFilePut): Promise<SkillFile> {
        const file = await unwrap(skillsSave({ client: api.client, query: { path, cwd: cwd() || undefined }, body }));
        settings.markReload(translate('settings.packagesStore.extensionsAndSkills'));
        resourcesChanged();
        return file;
      },
    };
    return methods;
  }),
);
export type PackagesStore = InstanceType<typeof PackagesStore>;
