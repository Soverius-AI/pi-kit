import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const out = 'apps/onboarding-site/public/i18n';
mkdirSync(out, { recursive: true });
for (const lang of ['en', 'de']) {
  const all = JSON.parse(readFileSync(`libs/shared/i18n/src/lib/translations/${lang}.json`, 'utf8'));
  writeFileSync(`${out}/${lang}.json`, JSON.stringify({ remoteSite: all.remoteSite }));
}
