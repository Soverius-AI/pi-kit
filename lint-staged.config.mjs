export default {
  'libs/shared/i18n/src/lib/translations/*.json': () => 'pnpm run check:i18n',
  // lint-staged supplies filenames as arguments, including spaces and apostrophes.
  '*': ['node scripts/lint-files.mjs', 'node scripts/format-angular.mjs --write'],
};
