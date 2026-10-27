export type PiModule = typeof import('@earendil-works/pi-coding-agent', { with: { 'resolution-mode': 'import' } });
export type PiMcpModule = typeof import('@earendil-works/pi-mcp', { with: { 'resolution-mode': 'import' } });

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PiResolution, PiSdkRange } from '@pi-kit/protocol';
// eslint-disable-next-line @nx/enforce-module-boundaries -- The supported SDK range is declared in the workspace build manifest.
import rootPackage from '../../../../package.json';
import { agentDirOf, bundledPiDir, piMcpEntry, resolvePi } from './pi-resolution';

/**
 * `@earendil-works/pi-coding-agent` is ESM-only (its `exports` map has no `require` condition) and
 * the backend is bundled as CommonJS, where a plain `import()` would be compiled to `require()`.
 * Loading it through `new Function` keeps a real dynamic `import()` that Node resolves natively.
 *
 * This is the one place the pi packages are loaded; `PiSessionService` (sessions), `PiConfigService`
 * (settings, providers, login) and `TrustService` (project trust) go through it. Which copy is loaded is decided once, when
 * the first caller asks (`piResolution()`): `PI_KIT_PI_DIR`, pi's managed install, or the copy bundled with pi-kit.
 * A running backend keeps the copy it loaded; an update takes effect after a restart.
 */
const nativeImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>;
let piModule: Promise<PiModule> | undefined;
let piMcpModule: Promise<PiMcpModule> | undefined;
let resolution: PiResolution | undefined;

/** The SDK range this pi-kit was built against: `piSdk` of the root `package.json`. */
export const PI_SDK_RANGE: PiSdkRange = (rootPackage as { piSdk: PiSdkRange }).piSdk;

/** Where "Use previous release" is kept (pi-kit's own data folder, not pi's). */
export function pinFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['PI_KIT_DATA_DIR'] || join(process.cwd(), '.pi-kit-data'), 'pi-release.json');
}

export function readPin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const value = (JSON.parse(readFileSync(pinFile(env), 'utf8')) as { pin?: unknown }).pin;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writePin(pin: string | null, env: NodeJS.ProcessEnv = process.env): void {
  const file = pinFile(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ pin })}\n`);
}

/** The choice of pi, made on the first call and kept for the life of the process (the loaded module cannot change). */
export function piResolution(): PiResolution {
  if (resolution) return resolution;
  const bundledDir = bundledPiDir();
  if (!bundledDir) throw new Error('The pi package bundled with pi-kit was not found (node_modules/@earendil-works/pi-coding-agent).');
  const pinned = readPin();
  resolution = resolvePi({ env: process.env, agentDir: agentDirOf(process.env), bundledDir, range: PI_SDK_RANGE, ...(pinned ? { pinned } : {}) });
  return resolution;
}

/** For tests: forget the choice and the loaded modules. */
export function resetPiResolution(): void {
  resolution = undefined;
  piModule = undefined;
  piMcpModule = undefined;
}

/** pi's MCP client package (a dependency of pi); the transports in it are what pi's own MCP extension connects with. */
export function loadPiMcp(): Promise<PiMcpModule> {
  piMcpModule ??= nativeImport<PiMcpModule>(pathToFileURL(piMcpEntry(piResolution())).href);
  return piMcpModule;
}
export function loadPi(): Promise<PiModule> {
  piModule ??= nativeImport<PiModule>(pathToFileURL(join(piResolution().packageDir, 'dist', 'index.js')).href).then((pi) => {
    try {
      // Extensions read `ctx.ui.theme`; pi's own RPC mode has the same global to hand them.
      pi.initTheme('dark', false);
    } catch {
      // No theme means `ctx.ui.theme` throws for an extension that uses it; nothing else depends on it.
    }
    return pi;
  });
  return piModule;
}
