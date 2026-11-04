import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideLanguage, type LanguageCode } from '@pi-kit/i18n';
import { Onboarding } from './app/onboarding';
import { SiteStorage } from './app/storage';

bootstrapApplication(Onboarding, {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideLanguage((): LanguageCode => {
      const value =
        new URLSearchParams(location.search).get('lang') ??
        SiteStorage.read(SiteStorage.LANGUAGE) ??
        navigator.language;
      return value.startsWith('de') ? 'de' : 'en';
    }),
  ],
}).catch((error) => console.error(error));
