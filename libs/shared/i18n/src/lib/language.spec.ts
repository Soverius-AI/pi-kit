import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import en from './translations/en.json';
import de from './translations/de.json';
import { Language, LanguageLoader, readLanguagePreference } from './language';

describe('Language', () => {
  let http: HttpTestingController;
  let language: Language;

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTransloco({
          config: { availableLangs: ['en', 'de'], defaultLang: 'en', reRenderOnLangChange: true, failedRetries: 0 },
          loader: LanguageLoader,
        }),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    language = TestBed.inject(Language);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
    document.documentElement.lang = 'en';
  });

  it('starts in English and loads catalogs relative to the renderer document', async () => {
    const initialized = language.initialize();
    http.expectOne('./i18n/en.json').flush(en);
    await initialized;
    expect(language.code()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(language.t('settings.language.name')).toBe('Interface language');
  });

  it('uses a saved German preference on the first render', async () => {
    localStorage.setItem('pi-kit.look', JSON.stringify({ language: 'de' }));
    const initialized = language.initialize();
    http.expectOne('./i18n/en.json').flush(en);
    await Promise.resolve();
    http.expectOne('./i18n/de.json').flush(de);
    await initialized;
    expect(language.code()).toBe('de');
    expect(language.locale()).toBe('de-DE');
    expect(document.documentElement.lang).toBe('de');
    expect(language.t('settings.language.name')).toBe('Sprache der Oberfläche');
  });

  it('uses a prepared desktop preference without accessing synchronous browser storage', async () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Desktop bootstrap must use its prepared cache');
    });
    const initialized = language.initialize(readLanguagePreference('{"language":"de"}'));
    http.expectOne('./i18n/en.json').flush(en);
    await Promise.resolve();
    http.expectOne('./i18n/de.json').flush(de);
    await initialized;
    expect(language.code()).toBe('de');
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the latest choice when an older language request finishes later', async () => {
    const german = language.activate('de');
    const pending = http.expectOne('./i18n/de.json');
    const english = language.activate('en');
    http.expectOne('./i18n/en.json').flush(en);
    expect(await english).toBe(true);
    pending.flush(de);
    expect(await german).toBe(false);
    expect(language.code()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('keeps the current interface on a load failure and permits a retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = language.activate('de');
    http.expectOne('./i18n/de.json').flush('offline', { status: 503, statusText: 'Unavailable' });
    expect(await failed).toBe(false);
    expect(language.code()).toBe('en');
    expect(language.error()).toBe(true);
    const retried = language.activate('de');
    http.expectOne('./i18n/de.json').flush(de);
    expect(await retried).toBe(true);
    expect(language.error()).toBe(false);
    expect(language.t('settings.language.heading')).toBe('Sprache');
  });

  it.each([null, '{broken', '{}', '{"language":"fr"}', '{"language":null}'])(
    'falls back to English for an absent or invalid cached preference: %s',
    (value) => {
      if (value !== null) localStorage.setItem('pi-kit.look', value);
      expect(readLanguagePreference()).toBe('en');
    },
  );
});
