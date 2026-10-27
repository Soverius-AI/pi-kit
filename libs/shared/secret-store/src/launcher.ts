import type { ResolverPlatform } from '@pi-kit/protocol';

/**
 * The small script that puts `pi-kit-secret` on PATH: the packaged app has no `node` of its own, only Electron, so the launcher starts the CLI bundle with
 * Electron's Node (`ELECTRON_RUN_AS_NODE=1`); a development checkout starts it with the `node` that is running. Pure: the text of the script for each platform, so
 * the unit tests cover what Settings › Advanced writes.
 */
export interface LauncherTarget {
  /** The executable that runs the bundle: Electron's binary in the packaged app, `node` in development. */
  runtime: string;
  /** Set `ELECTRON_RUN_AS_NODE=1` (the runtime is Electron). */
  electron: boolean;
  /** The CLI bundle (`pi-kit-secret.cjs`). */
  script: string;
  /** Explicit store choice for terminals without the app environment. */
  secretStore?: string;
}

const sh = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
const cmd = (text: string): string => `"${text.replace(/"/g, '""')}"`;

export function launcherScript(platform: ResolverPlatform, target: LauncherTarget): string {
  const setting = target.secretStore;
  if (setting !== undefined && (
    !(['macos', 'legacy', 'memory', 'none'].includes(setting) || (setting.startsWith('file:') && setting.length > 5)) ||
    /[\0\r\n]/.test(setting) ||
    (platform === 'win32' && /["%!^&|<>]/.test(setting))
  )) throw new Error('Invalid secret store setting for launcher.');
  if (platform === 'win32') {
    return `@echo off\r\nrem Written by pi-kit (Settings > Advanced). Reads and writes pi-kit's entries in the Windows Credential Manager.\r\n${target.electron ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''}${setting === undefined ? '' : `set "PI_KIT_SECRET_STORE=${setting}"\r\n`}${cmd(target.runtime)} ${cmd(target.script)} %*\r\n`;
  }
  return `#!/bin/sh\n# Written by pi-kit (Settings > Advanced). Reads and writes pi-kit's entries in the system credential store.\n${target.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${setting === undefined ? '' : `PI_KIT_SECRET_STORE=${sh(setting)} `}exec ${sh(target.runtime)} ${sh(target.script)} "$@"\n`;
}

/** The file name of the launcher on this platform. */
export const launcherName = (platform: ResolverPlatform): string => (platform === 'win32' ? 'pi-kit-secret.cmd' : 'pi-kit-secret');

/** Where "Install on PATH" puts it when nothing else is chosen: a folder that is on PATH for most shells already, or that the user is told to add. */
export function defaultInstallDir(platform: ResolverPlatform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') return `${env['LOCALAPPDATA'] ?? `${home}\\AppData\\Local`}\\pi-kit\\bin`;
  return `${home}/.local/bin`;
}
