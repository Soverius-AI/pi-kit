import { provideEnvironmentInitializer, inject, importProvidersFrom } from '@angular/core';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import en from './lib/translations/en.json';
import de from './lib/translations/de.json';
export default [
  importProvidersFrom(
    TranslocoTestingModule.forRoot({
      langs: { en, de },
      translocoConfig: { availableLangs: ['en', 'de'], defaultLang: 'en', reRenderOnLangChange: true },
    }),
  ),
  provideEnvironmentInitializer(() => {
    const service = inject(TranslocoService);
    service.setTranslation(en, 'en');
    service.setTranslation(de, 'de');
    service.setActiveLang('en');
  }),
];
