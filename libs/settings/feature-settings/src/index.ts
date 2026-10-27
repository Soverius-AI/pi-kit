// Public API of @pi-kit/settings/feature-settings (`type:feature`, `scope:settings`): the Settings dialog. `SettingsDialog` is the host in the shell; the window (nav, search,
// the section pages) is a lazy chunk it loads with `@defer`, so it is not exported here: a barrel that re-exported it would put it in the initial bundle. The sections of
// the other `feature-*` libraries are imported by the window, so they ship in that chunk.
export * from './lib/settings-dialog';
