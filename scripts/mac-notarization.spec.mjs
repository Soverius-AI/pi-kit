import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { notarizationEnabled, notarizeArtifact, withNotarizationRecovery, installNotarizationRecovery } = require('./mac-notarization.cjs');
const env = { PI_KIT_BUILD_PLATFORM: 'darwin', PI_KIT_NOTARIZE: '1', CSC_NAME: 'Fixture (ABCDE12345)' };
const profileEnv = { ...env, APPLE_KEYCHAIN_PROFILE: 'fixture-profile' };
const submission = '34772e11-a383-4c64-92ce-066fbad677ae';
const timeout = new Error(`HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out." NSErrorFailingURLStringKey=https://appstoreconnect.apple.com/notary/v2/submissions/${submission}?)`);
const interrupted = async () => { throw timeout; };
const accepted = { code: 0, output: JSON.stringify({ id: submission, status: 'Accepted' }) };
const stapled = { code: 0, output: 'The staple and validate action worked!' };

function recoveryHarness(results, budgetMs = 300_000) {
  let clock = 0;
  const calls = [];
  const logs = [];
  const delays = [];
  return {
    calls, logs, delays,
    options: {
      run: async (args, timeoutMs) => {
        calls.push(args);
        assert.ok(timeoutMs > 0 && timeoutMs <= Math.min(45_000, budgetMs - clock));
        assert.ok(results.length, 'Unexpected additional command');
        return results.shift();
      },
      now: () => clock,
      sleep: async (ms) => { delays.push(ms); clock += ms; },
      log: (message) => logs.push(message),
      budgetMs,
    },
  };
}

test('requested notarization cannot silently skip signing or authentication', () => {
  assert.equal(notarizationEnabled({}), false);
  assert.equal(notarizationEnabled({ ...env, PI_KIT_BUILD_PLATFORM: 'win32' }), false);
  assert.throws(() => notarizationEnabled({ ...env, CSC_NAME: '' }), /signing identity/);
  assert.throws(() => notarizationEnabled(env), /credentials|PROFILE/);
  assert.throws(() => notarizationEnabled({ ...env, APPLE_ID: 'fixture@example.invalid', APPLE_KEYCHAIN_PROFILE: 'profile' }), /together/);
  assert.throws(() => notarizationEnabled({ ...env, APPLE_API_KEY: '/missing/key.p8', APPLE_API_KEY_ID: 'ID', APPLE_API_ISSUER: 'issuer' }), /existing/);
  assert.equal(notarizationEnabled({ ...env, APPLE_KEYCHAIN_PROFILE: 'profile' }), true);
  assert.equal(notarizationEnabled({ ...env, APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'ABCDE12345' }), true);
});

test('a timed-out status request resumes the existing submission without uploading again', async () => {
  const harness = recoveryHarness([accepted, stapled]);
  let uploads = 0;
  await withNotarizationRecovery(async () => { uploads++; throw timeout; }, '/build/pi-kit.app', profileEnv, harness.options);
  assert.equal(uploads, 1);
  assert.deepEqual(harness.calls, [
    ['notarytool', 'info', submission, '--keychain-profile', 'fixture-profile', '--output-format', 'json'],
    ['stapler', 'staple', '/build/pi-kit.app'],
  ]);
  assert.match(harness.logs.at(-1), /recovered and ticket stapled/);
});

test('transient status failures and ticket propagation delays recover after acceptance', async () => {
  const harness = recoveryHarness([
    { code: 1, output: 'HTTP statusCode: 503' },
    { code: 0, output: JSON.stringify({ status: 'In Progress' }) },
    accepted,
    { code: 65, output: 'Record not found' },
    stapled,
  ]);
  await withNotarizationRecovery(interrupted, '/build/pi-kit.dmg', profileEnv, harness.options);
  assert.deepEqual(harness.calls.map((args) => args.slice(0, 2)), [
    ['notarytool', 'info'], ['notarytool', 'info'], ['notarytool', 'info'], ['stapler', 'staple'], ['stapler', 'staple'],
  ]);
  assert.deepEqual(harness.delays, [5_000, 15_000, 5_000]);
});

test('successful notarization and unrelated failures do not start recovery', async () => {
  const harness = recoveryHarness([]);
  assert.equal(await withNotarizationRecovery(async () => 'done', 'app', profileEnv, harness.options), 'done');
  for (const message of ['Request timed out without a submission ID', `HTTP 401 unauthorized timeout /notary/v2/submissions/${submission}`, `Invalid code signature /notary/v2/submissions/${submission}`]) {
    const failure = new Error(message);
    await assert.rejects(withNotarizationRecovery(async () => { throw failure; }, 'app', profileEnv, harness.options), (error) => error === failure);
  }
  assert.equal(harness.calls.length, 0);
});

test('rejected, malformed and unauthorized status responses fail without stapling or exposing credentials', async () => {
  const password = 'fixture-password-must-not-be-logged';
  const credentials = { ...env, APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: password, APPLE_TEAM_ID: 'ABCDE12345' };
  for (const result of [
    { code: 0, output: JSON.stringify({ status: 'Invalid' }) },
    { code: 0, output: `invalid JSON ${password}` },
    { code: 1, output: `HTTP 401 Unauthorized: ${password}` },
  ]) {
    const harness = recoveryHarness([result]);
    await assert.rejects(withNotarizationRecovery(interrupted, 'app', credentials, harness.options), (error) => !error.message.includes(password));
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.calls[0].slice(3, -2), ['--apple-id', credentials.APPLE_ID, '--password', password, '--team-id', credentials.APPLE_TEAM_ID]);
    assert.ok(harness.logs.every((message) => !message.includes(password)));
  }
});

test('status network retries and total recovery time are bounded', async () => {
  const network = recoveryHarness(Array.from({ length: 3 }, () => ({ code: 1, output: 'ETIMEDOUT' })));
  await assert.rejects(withNotarizationRecovery(interrupted, 'app', profileEnv, network.options), /remains unverified/);
  assert.equal(network.calls.length, 3);
  const pending = recoveryHarness([{ code: 0, output: JSON.stringify({ status: 'In Progress' }) }], 1_000);
  await assert.rejects(withNotarizationRecovery(interrupted, 'app', profileEnv, pending.options), /recovery timed out/);
  assert.equal(pending.calls.length, 1);
  assert.deepEqual(pending.delays, [1_000]);
  const noTicket = recoveryHarness([accepted, ...Array.from({ length: 3 }, () => ({ code: 65, output: 'Record not found' }))]);
  await assert.rejects(withNotarizationRecovery(interrupted, 'app', profileEnv, noTicket.options), /Could not staple/);
  assert.equal(noTicket.calls.length, 4);
});

test('the builder helper is wrapped once and recovers both the app and DMG with its original receiver', async () => {
  const harness = recoveryHarness([accepted, stapled, accepted, stapled]);
  const uploaded = [];
  const helper = { async notarizeIfProvided(file) { assert.equal(this, helper); uploaded.push(file); throw timeout; } };
  const context = { packager: { helper } };
  installNotarizationRecovery(context, { ...profileEnv, PI_KIT_NOTARIZE: '0' }, harness.options);
  const original = helper.notarizeIfProvided;
  installNotarizationRecovery(context, profileEnv, harness.options);
  assert.notEqual(helper.notarizeIfProvided, original);
  const wrapped = helper.notarizeIfProvided;
  installNotarizationRecovery(context, profileEnv, harness.options);
  assert.equal(helper.notarizeIfProvided, wrapped);
  await helper.notarizeIfProvided('/build/pi-kit.app');
  await helper.notarizeIfProvided('/build/pi-kit.dmg');
  assert.deepEqual(uploaded, ['/build/pi-kit.app', '/build/pi-kit.dmg']);
  assert.deepEqual(harness.calls.filter((args) => args[0] === 'stapler').map((args) => args[2]), uploaded);
  assert.throws(() => installNotarizationRecovery({ packager: {} }, profileEnv), /helper is unavailable/);
});

test('DMG stapling refreshes blockmap and update metadata before publishing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-notarization-'));
  const file = join(root, 'app.dmg');
  writeFileSync(file, 'signed disk image');
  const event = { file, updateInfo: { size: 17, sha512: 'old' } };
  const calls = [];
  await notarizeArtifact(event, { ...env, APPLE_KEYCHAIN_PROFILE: 'profile' }, {
    notarize: async (path) => { calls.push('notarize'); writeFileSync(path, 'signed disk image with stapled ticket'); },
    verify: (path, diskImage) => { assert.equal(path, file); assert.equal(diskImage, true); calls.push('verify'); },
  });
  assert.deepEqual(calls, ['notarize', 'verify']);
  const final = readFileSync(file);
  assert.equal(event.updateInfo.size, final.length);
  assert.equal(event.updateInfo.sha512, createHash('sha512').update(final).digest('base64'));
  const map = JSON.parse(gunzipSync(readFileSync(`${file}.blockmap`)));
  assert.equal(map.files[0].sizes.reduce((sum, size) => sum + size, 0), final.length);
});

test('failed DMG notarization leaves the build failed, and ZIP is already stapled inside', async () => {
  let called = false;
  const options = { notarize: async () => { throw new Error('Rejected by Apple'); }, verify: () => { called = true; } };
  await assert.rejects(notarizeArtifact({ file: 'app.dmg' }, { ...env, APPLE_KEYCHAIN_PROFILE: 'profile' }, options), /Rejected/);
  assert.equal(called, false);
  await notarizeArtifact({ file: 'app.zip' }, { ...env, APPLE_KEYCHAIN_PROFILE: 'profile' }, options);
});
