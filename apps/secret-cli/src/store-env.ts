/**
 * Invoking the helper explicitly authorizes credential access. Old installed launchers
 * predate the embedded store setting; keep them working without changing the app default.
 * Explicit overrides always win. This pure adapter never loads or queries a native store.
 */
export function cliStoreEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return platform === 'darwin' && !env['PI_KIT_SECRET_STORE']
    ? { ...env, PI_KIT_SECRET_STORE: 'macos' }
    : env;
}
