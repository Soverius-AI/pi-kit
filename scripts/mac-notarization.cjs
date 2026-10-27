const { execFileSync, spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

/** Match electron-builder's credential precedence, but fail instead of silently skipping notarization. */
function notarizationEnabled(env = process.env) {
  if (env.PI_KIT_BUILD_PLATFORM !== 'darwin' || env.PI_KIT_NOTARIZE !== '1') return false;
  if (!env.CSC_NAME && !env.CSC_LINK) throw new Error('Notarization requires a Developer ID signing identity (CSC_NAME or CSC_LINK).');
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
    if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) return true;
    throw new Error('Notarization requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID together.');
  }
  if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) {
    if (env.APPLE_API_KEY && existsSync(env.APPLE_API_KEY) && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) return true;
    throw new Error('Notarization requires an existing APPLE_API_KEY file, APPLE_API_KEY_ID and APPLE_API_ISSUER.');
  }
  if (env.APPLE_KEYCHAIN_PROFILE) return true;
  throw new Error('Notarization requires APPLE_KEYCHAIN_PROFILE, Apple ID credentials or an App Store Connect API key.');
}

function authorizationArgs(env) {
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
  if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  return ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? ['--keychain', env.APPLE_KEYCHAIN] : [])];
}

function transientNetworkFailure(message) {
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid credentials/i.test(message)) return false;
  return /NSURLErrorDomain Code=-100[159]|timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network connection was lost|(?:HTTP|statusCode)[^\n]{0,80}\b(?:500|502|503|504)\b/i.test(message);
}

/** Never include command arguments in errors: authentication arguments can contain a password. */
function runNotaryCommand(args, timeout) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout });
    const collect = (chunk) => { output = (output + chunk).slice(-65_536); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => resolve({ code: -1, output: 'Could not start xcrun.' }));
    child.on('close', (code, signal) => resolve({ code: code ?? -1, output: signal ? 'The request timed out.' : output }));
  });
}

/** A failed --wait does not cancel Apple's submission. Resume its status check without uploading again. */
async function withNotarizationRecovery(notarize, file, env = process.env, overrides = {}) {
  let submission;
  try {
    return await notarize();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    submission = new RegExp(`/notary/v2/submissions/(${uuid})`, 'i').exec(message)?.[1]
      || new RegExp(`"id"\\s*:\\s*"(${uuid})"`, 'i').exec(message)?.[1];
    if (!submission || !transientNetworkFailure(message)) throw error;
  }
  const run = overrides.run || runNotaryCommand;
  const pause = overrides.sleep || sleep;
  const now = overrides.now || Date.now;
  const log = overrides.log || console.log;
  const deadline = now() + (overrides.budgetMs ?? 300_000);
  const auth = authorizationArgs(env);
  const remaining = () => Math.max(0, deadline - now());
  const timedOut = () => new Error(`Notarization recovery timed out for submission ${submission}. Apple may still be processing it; the build remains unverified.`);
  const command = async (args) => {
    if (!remaining()) throw timedOut();
    return run(args, Math.min(45_000, remaining()));
  };
  const delay = async (ms) => {
    if (!remaining()) throw timedOut();
    await pause(Math.min(ms, remaining()));
  };
  log(`  • resuming notarization status for submission ${submission} after a temporary network failure`);
  let networkFailures = 0;
  while (remaining()) {
    const result = await command(['notarytool', 'info', submission, ...auth, '--output-format', 'json']);
    if (result.code !== 0) {
      if (!transientNetworkFailure(result.output) || ++networkFailures >= 3) throw new Error(`Could not retrieve notarization status for submission ${submission}. The build remains unverified.`);
      await delay(5_000 * networkFailures);
      continue;
    }
    let status;
    try { status = JSON.parse(result.output).status; } catch { throw new Error(`Invalid notarization status response for submission ${submission}.`); }
    if (status === 'In Progress') {
      await delay(15_000);
      continue;
    }
    if (status !== 'Accepted') throw new Error(`Notarization submission ${submission} was not accepted (status: ${status}). Inspect its notarytool log.`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const stapled = await command(['stapler', 'staple', file]);
      if (stapled.code === 0) {
        log(`  • notarization recovered and ticket stapled (submission ${submission})`);
        return;
      }
      // Accepted tickets can take a moment to reach CloudKit.
      if (attempt === 3 || (!transientNetworkFailure(stapled.output) && !/Record not found|Error 65|Could not find.*ticket/i.test(stapled.output))) throw new Error(`Could not staple the accepted notarization ticket for submission ${submission}.`);
      await delay(5_000 * attempt);
    }
  }
  throw timedOut();
}

const wrappedHelpers = new WeakSet();

/** Installed before signing, so the app and the later DMG use the same recovery path. */
function installNotarizationRecovery(context, env = process.env, overrides = {}) {
  if (!notarizationEnabled(env)) return;
  const helper = context.packager.helper;
  if (!helper || typeof helper.notarizeIfProvided !== 'function') throw new Error('The electron-builder notarization helper is unavailable.');
  if (wrappedHelpers.has(helper)) return;
  const notarize = helper.notarizeIfProvided.bind(helper);
  helper.notarizeIfProvided = (file) => withNotarizationRecovery(() => notarize(file), file, env, overrides);
  wrappedHelpers.add(helper);
}

function verify(file, diskImage = false) {
  execFileSync('xcrun', ['stapler', 'validate', file], { stdio: 'inherit' });
  execFileSync('spctl', ['--assess', '--verbose=2', ...(diskImage ? ['--type', 'open', '--context', 'context:primary-signature'] : ['--type', 'execute']), file], { stdio: 'inherit' });
}

/** electron-builder notarizes/staples the app before packing ZIP and DMG. Check that ticket before packing. */
function afterSign(context) {
  if (!notarizationEnabled()) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  verify(app);
}

/** Also notarize the outer DMG, then refresh its update metadata after stapling changes its bytes. */
async function notarizeArtifact(event, env = process.env, overrides = {}) {
  if (!notarizationEnabled(env) || !event.file?.endsWith('.dmg')) return;
  const notarize = overrides.notarize || ((file) => event.packager.helper.notarizeIfProvided(file));
  const verifyArtifact = overrides.verify || verify;
  // Use the pinned electron-builder toolchain's blockmap algorithm, including its checksum format.
  const blockmap = overrides.blockmap || createRequire(require.resolve('electron-builder'))('app-builder-lib/out/targets/blockmap/blockmap').buildBlockMap;
  await notarize(event.file);
  verifyArtifact(event.file, true);
  if (event.updateInfo) event.updateInfo = await blockmap(event.file, 'gzip', `${event.file}.blockmap`);
  // artifactCreated (which writes latest-mac.yml) follows this hook, so it receives the final digest/size.
}

module.exports = { notarizationEnabled, installNotarizationRecovery, withNotarizationRecovery, afterSign, notarizeArtifact };
