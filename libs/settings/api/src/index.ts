// Public API of @pi-kit/settings/api (`type:api`, `scope:settings`): what the other domains and the shell use of settings.
//
// - the stores from `settings/data` (`SettingsStore`, `ConnectorsStore`, `ProviderCardsStore`),
// - the onboarding's provider cards (`GetModel`); the API-key and sign-in flows and the local runtime wizard, which Settings and the onboarding both show; and the file
//   editor dialog and the setting row the section libraries share: components that depend on `settings/data` only.
//
// Everything here is `export *`, never a list of names: a named `export { X } from` clause keeps X's module in the initial bundle even when only a lazy chunk uses X
// (measured), and the lazy settings window and onboarding must stay out of it. What the other domains may use is therefore what `settings/data` exports,
// which is kept to what the section libraries and this api need.
export * from '@pi-kit/settings/data';
export * from './lib/get-model';
export * from './lib/key-workflow';
export * from './lib/login-flow';
export * from './lib/setting-row';
export * from './lib/file-editor';
export * from './lib/local-runtime-wizard';
