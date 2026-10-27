import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { macSigningOptions, macSigningIdentity } = createRequire(import.meta.url)('./mac-signing.cjs');

test('Touch ID signing uses the app group only on the main executable, and embeds a profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-signing-'));
  mkdirSync(join(root, 'apps/desktop/build'), { recursive: true });
  writeFileSync(join(root, 'apps/desktop/build/entitlements.mac.plist'), '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
  const profile = join(root, 'app.provisionprofile');
  writeFileSync(profile, 'fixture');
  const options = macSigningOptions({ PI_KIT_BUILD_PLATFORM: 'darwin', CSC_NAME: 'Developer ID Application: Fixture (ABCDE12345)', PI_KIT_MAC_PROVISIONING_PROFILE: profile }, root);
  assert.equal(options.provisioningProfile, profile);
  assert.equal(options.entitlementsInherit, 'apps/desktop/build/entitlements.mac.plist');
  const xml = readFileSync(options.entitlements, 'utf8');
  assert.match(xml, /<key>keychain-access-groups<\/key><array><string>ABCDE12345.dev.pi-kit.app<\/string>/);
  assert.match(xml, /com.apple.security.cs.allow-jit/);
});

test('signed macOS builds require a Team ID and profile; other targets keep their original entitlements', () => {
  assert.throws(() => macSigningOptions({ PI_KIT_BUILD_PLATFORM: 'darwin', CSC_LINK: 'fixture' }), /provisioning/i);
  assert.equal(macSigningOptions({ PI_KIT_BUILD_PLATFORM: 'win32', CSC_LINK: 'fixture' }).entitlements, 'apps/desktop/build/entitlements.mac.plist');
});

test('signing accepts a full Developer ID name or selects a .p12 identity by Team ID', () => {
  assert.equal(macSigningIdentity({ CSC_NAME: 'Developer ID Application: Fixture (ABCDE12345)' }), 'Fixture (ABCDE12345)');
  assert.equal(macSigningIdentity({ CSC_LINK: 'fixture.p12', APPLE_TEAM_ID: 'ABCDE12345' }), 'ABCDE12345');
  assert.equal(macSigningIdentity({}), null);
});
