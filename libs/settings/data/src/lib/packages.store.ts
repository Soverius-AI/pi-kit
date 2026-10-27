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
  skillsRead,
  skillsSearch,
  skillsDetail,
  skillsInstall,
  skillsRemove,
  unwrap,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type {
  InstallPackage,
  InstallSkill,
  SkillSearchResponse,
  SkillDetail,
  PackageDetail,
  PackageSearchKind,
  PackageSearchResponse,
  PackagesOverview,
  SkillFile,
} from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';

import { SettingsStore } from './settings.store';

interface PackagesState {
  overview: PackagesOverview | undefined;
  loading: boolean;
  checking: boolean;
  busy: ReadonlySet<string>;
  wizard: boolean;
  error: string | undefined;
}

export const PackagesStore = signalStore(
  { providedIn: 'root' },
  withState<PackagesState>({
    overview: undefined,
    loading: false,
    checking: false,
    busy: new Set<string>(),
    wizard: false,
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

      searchSkills(q: string, signal?: AbortSignal): Promise<SkillSearchResponse> {
        return unwrap(skillsSearch({ client: api.client, query: { q }, signal }));
      },
      skillDetail(source: string, name: string, signal?: AbortSignal): Promise<SkillDetail> {
        return unwrap(skillsDetail({ client: api.client, query: { source, name }, signal }));
      },
      async installSkill(body: InstallSkill): Promise<{ ok: true } | { ok: false; error: string }> {
        setBusy('skill:+', true);
        try {
          const result = await unwrap(skillsInstall({ client: api.client, query: { cwd: cwd() || undefined }, body }));
          settings.markReload(translate('settings.packagesStore.extensionsAndSkills'));
          resourcesChanged();
          toasts.show('success', result.message, 4000);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        } finally {
          setBusy('skill:+', false);
        }
      },
      async removeSkill(path: string, mtime: number): Promise<{ ok: true } | { ok: false; error: string }> {
        setBusy(path, true);
        try {
          const result = await unwrap(
            skillsRemove({ client: api.client, query: { path, cwd: cwd() || undefined }, body: { mtime } }),
          );
          settings.markReload(translate('settings.packagesStore.extensionsAndSkills'));
          resourcesChanged();
          toasts.show('success', result.message, 4000);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        } finally {
          setBusy(path, false);
        }
      },

      skillFile: (path: string): Promise<SkillFile> =>
        unwrap(skillsRead({ client: api.client, query: { path, cwd: cwd() || undefined } })),
    };
    return methods;
  }),
);
export type PackagesStore = InstanceType<typeof PackagesStore>;
