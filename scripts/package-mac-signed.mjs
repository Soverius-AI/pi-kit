// Local signing settings stay outside source control; exported variables take precedence.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { macSigningOptions } = require('./mac-signing.cjs');
const { notarizationEnabled } = require('./mac-notarization.cjs');
const config = join(root, '.env.mac-signing.local');
const env = {
  ...(existsSync(config) ? parseEnv(readFileSync(config, 'utf8')) : {}),
  ...process.env,
};
env.PI_KIT_BUILD_PLATFORM = 'darwin';
env.PI_KIT_NOTARIZE ??= '1';
const args = process.argv.slice(2);

try {
  if (process.platform !== 'darwin') throw new Error('Signed macOS builds must run on a Mac.');
  if (env.CSC_KEYCHAIN && env.PI_KIT_MAC_KEYCHAIN_PASSWORD) {
    const unlocked = spawnSync('security', ['unlock-keychain', '-p', env.PI_KIT_MAC_KEYCHAIN_PASSWORD, env.CSC_KEYCHAIN], { stdio: 'pipe' });
    if (unlocked.status !== 0) throw new Error('Could not unlock the local signing keychain. Check CSC_KEYCHAIN and PI_KIT_MAC_KEYCHAIN_PASSWORD.');
  }
  if (!env.CSC_NAME && !env.CSC_LINK) {
    throw new Error('This Mac needs signing setup. Run: pnpm mac:signing:setup "/path/to/developer-id-cirgzuda" (or configure CSC_NAME / CSC_LINK in .env.mac-signing.local).');
  }
  // Fail before the production build, including when a public certificate has no private key.
  if (env.CSC_NAME && !env.CSC_LINK) {
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning', ...(env.CSC_KEYCHAIN ? [env.CSC_KEYCHAIN] : [])], { encoding: 'utf8' });
    const name = env.CSC_NAME.replace(/^Developer ID Application:\s*/, '');
    const identity = identities.split('\n').find((line) => line.includes('"Developer ID Application: ') && line.includes(name));
    if (!identity) throw new Error(`No valid Developer ID Application identity matching "${name}". Import its certificate AND private key (.p12) into Keychain, or set CSC_LINK and CSC_KEY_PASSWORD. Apple Distribution certificates cannot sign this release.`);
    const team = /\(([A-Z0-9]{10})\)"/.exec(identity)?.[1];
    if (env.APPLE_TEAM_ID && env.APPLE_TEAM_ID !== team) throw new Error('APPLE_TEAM_ID does not match the Developer ID Application identity.');
    env.APPLE_TEAM_ID ||= team;
  }
  macSigningOptions(env, root);
  notarizationEnabled(env);
  console.log(`macOS signing configured; notarization ${env.PI_KIT_NOTARIZE === '1' ? 'enabled' : 'disabled'}.`);
  if (!args.includes('--check')) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), '--only', 'mac', ...args], { cwd: root, env, stdio: 'inherit' });
    if (result.error) throw new Error('Could not start the macOS release build.');
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(`Signed macOS build: ${error.message}`);
  process.exitCode = 1;
}
