import { DOCUMENT, registerLocaleData } from '@angular/common';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import {
  Injectable,
  computed,
  inject,
  isDevMode,
  makeEnvironmentProviders,
  provideAppInitializer,
  signal,
} from '@angular/core';
import { TranslocoService, provideTransloco, type TranslocoLoader, type Translation } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

export const LANGUAGES = ['en', 'de'] as const;
export type LanguageCode = (typeof LANGUAGES)[number];
export type Translate = (key: string, params?: Record<string, unknown>) => string;
export const isLanguage = (value: unknown): value is LanguageCode => value === 'en' || value === 'de';

/** Use the cached preference for the first paint; ViewPrefs reconciles it with the database. */
export function readLanguagePreference(cached?: string | null): LanguageCode {
  try {
    const value: unknown = JSON.parse(
      (cached === undefined ? localStorage.getItem('pi-kit.look') : cached) ?? '{}',
    ).language;
    return isLanguage(value) ? value : 'en';
  } catch {
    return 'en';
  }
}

/** Transloco's loader: fetches `./i18n/<language>.json` relative to the renderer document, for `en` and `de` only. */
@Injectable({ providedIn: 'root' })
export class LanguageLoader implements TranslocoLoader {
  private readonly http = inject(HttpClient);

  getTranslation(language: string) {
    if (!isLanguage(language)) throw new Error(`Unsupported language: ${language}`);
    // Relative to the renderer document, including the packaged Electron renderer.
    return this.http.get<Translation>(`./i18n/${language}.json`);
  }
}

/**
 * The UI language: the active code and locale as signals, `t` for translating in class code, and `activate`, which
 * loads a catalog in full before switching to it and keeps the current UI (with `error` set) when the load fails.
 */
@Injectable({ providedIn: 'root' })
export class Language {
  private readonly transloco = inject(TranslocoService);
  private readonly document = inject(DOCUMENT);
  private revision = 0;
  readonly code = computed(() => this.transloco.activeLang() as LanguageCode);
  readonly locale = computed(() => (this.code() === 'de' ? 'de-DE' : 'en-US'));
  private readonly loadError = signal(false);
  readonly error = this.loadError.asReadonly();

  /** Reading activeLang makes class methods and computed labels reactive, just like TranslocoPipe. */
  readonly t: Translate = (key, params = {}) => this.transloco.translate<string>(key, params, this.code());

  async initialize(preference = readLanguagePreference()): Promise<void> {
    await firstValueFrom(this.transloco.load('en'));
    await this.activate(preference);
  }

  /** Keep the current UI until the entire requested catalog is ready. The latest choice wins. */
  async activate(code: LanguageCode): Promise<boolean> {
    const revision = ++this.revision;
    this.loadError.set(false);
    try {
      await Promise.all([
        firstValueFrom(this.transloco.load(code)),
        code === 'de'
          ? import('@angular/common/locales/de').then((locale) => registerLocaleData(locale.default))
          : Promise.resolve(),
      ]);
      if (revision !== this.revision) return false;
      this.transloco.setActiveLang(code);
      this.document.documentElement.lang = code;
      return true;
    } catch {
      if (revision === this.revision) this.loadError.set(true);
      return false;
    }
  }
}

export function provideLanguage(readPreference: () => LanguageCode = readLanguagePreference) {
  return makeEnvironmentProviders([
    provideHttpClient(),
    provideTransloco({
      config: {
        availableLangs: [...LANGUAGES],
        defaultLang: 'en',
        // Loading failures stay errors so a failed locale can be retried; Language keeps the current UI.
        reRenderOnLangChange: true,
        failedRetries: 1,
        prodMode: !isDevMode(),
      },
      loader: LanguageLoader,
    }),
    provideAppInitializer(() => inject(Language).initialize(readPreference())),
  ]);
}
