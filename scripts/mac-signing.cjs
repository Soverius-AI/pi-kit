const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

// An explicit Team ID also selects an imported .p12 when automatic discovery is disabled.
exports.macSigningIdentity = function macSigningIdentity(env = process.env) {
  if (env.CSC_NAME) return env.CSC_NAME.replace(/^Developer ID Application:\s*/, '');
  return env.CSC_LINK ? env.APPLE_TEAM_ID : null;
};

/** Main executable also runs the backend and secret CLI, so all three share this entitled identity. */
exports.macSigningOptions = function macSigningOptions(env = process.env, root = resolve(__dirname, '..')) {
  const base = 'apps/desktop/build/entitlements.mac.plist';
  if (env.PI_KIT_BUILD_PLATFORM !== 'darwin' || (!env.CSC_NAME && !env.CSC_LINK)) return { entitlements: base, entitlementsInherit: base };
  const team = env.APPLE_TEAM_ID || /\(([A-Z0-9]{10})\)$/.exec(env.CSC_NAME || '')?.[1];
  const profile = env.PI_KIT_MAC_PROVISIONING_PROFILE;
  if (!team || !/^[A-Z0-9]{10}$/.test(team) || !profile || !existsSync(profile)) {
    throw new Error('Touch ID signing needs APPLE_TEAM_ID and PI_KIT_MAC_PROVISIONING_PROFILE (a profile for dev.pi-kit.app with Keychain Sharing).');
  }
  const output = join(root, 'dist/signing/entitlements.mac.plist');
  const identifiers = `
    <key>com.apple.application-identifier</key><string>${team}.dev.pi-kit.app</string>
    <key>com.apple.developer.team-identifier</key><string>${team}</string>
    <key>keychain-access-groups</key><array><string>${team}.dev.pi-kit.app</string></array>
  `;
  mkdirSync(join(root, 'dist/signing'), { recursive: true });
  writeFileSync(output, readFileSync(join(root, base), 'utf8').replace('</dict>', `${identifiers}</dict>`));
  return { entitlements: output, entitlementsInherit: base, provisioningProfile: resolve(profile) };
};
