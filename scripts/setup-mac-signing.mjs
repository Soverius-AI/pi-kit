// One-time setup per Mac. The exported signing folder and local settings never enter Git.
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = join(root, '.env.mac-signing.local');

// Suppress command arguments and output on failure: both can contain credentials.
function run(command, args, label, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, timeout: 60_000 });
  if (result.status !== 0) throw new Error(`${label} failed. Check the signing backup and macOS Keychain access.`);
  return result.stdout;
}

function save(env) {
  writeFileSync(config, '# Local macOS signing credentials. Never commit this file.\n' + Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
  chmodSync(config, 0o600);
}

try {
  if (process.platform !== 'darwin') throw new Error('Run signing setup on the Mac that will build the app.');
  const folder = process.argv[2];
  if (!folder || process.argv.length !== 3) throw new Error('Usage: pnpm mac:signing:setup "/path/to/developer-id-cirgzuda"');
  const source = resolve(folder);
  const required = ['setup.json', 'developer-id-application.p12', 'certificate-export-password.txt', 'pi-kit.provisionprofile', 'notarization-password.txt'];
  for (const file of required) if (!existsSync(join(source, file))) throw new Error(`Missing ${file} in the signing folder.`);
  const metadata = JSON.parse(readFileSync(join(source, 'setup.json'), 'utf8'));
  const team = metadata.teamId;
  const appleId = metadata.notarization?.appleId;
  const profileName = metadata.notarization?.profile || 'pi-kit-notarization';
  if (!/^[A-Z0-9]{10}$/.test(team) || !appleId) throw new Error('setup.json must contain teamId and notarization.appleId.');
  const exportPassword = readFileSync(join(source, 'certificate-export-password.txt'), 'utf8').trim();
  const notaryPassword = readFileSync(join(source, 'notarization-password.txt'), 'utf8').trim();
  if (!exportPassword || !notaryPassword) throw new Error('The certificate and notarization password files must contain their passwords.');
  const identityPem = run('/usr/bin/openssl', ['pkcs12', '-in', join(source, 'developer-id-application.p12'), '-nodes', '-passin', 'stdin'], 'Read signing bundle', exportPassword + '\n');
  const cert = new X509Certificate(identityPem);
  const privatePem = identityPem.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/)?.[0];
  const name = cert.subject.split('\n').find((line) => line.startsWith('CN='))?.slice(3);
  if (!privatePem || !cert.checkPrivateKey(createPrivateKey(privatePem)) || !name?.startsWith('Developer ID Application: ') || !name.endsWith(`(${team})`)) {
    throw new Error('The signing bundle must contain the matching Developer ID Application certificate and private key for this team.');
  }
  if (Date.parse(cert.validTo) <= Date.now()) throw new Error('The Developer ID Application certificate has expired.');
  const profileXml = run('/usr/bin/security', ['cms', '-D', '-i', join(source, 'pi-kit.provisionprofile')], 'Read provisioning profile');
  const app = /<key>com\.apple\.application-identifier<\/key>\s*<string>([^<]+)<\/string>/.exec(profileXml)?.[1];
  if (app !== `${team}.dev.pi-kit.app`) throw new Error('The provisioning profile must be for this team and dev.pi-kit.app.');

  const destination = join(homedir(), '.config/pi-kit/signing');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  const keychain = join(destination, 'pi-kit.keychain-db');
  const env = existsSync(config) ? parseEnv(readFileSync(config, 'utf8')) : {};
  let password = env.CSC_KEYCHAIN === keychain ? env.PI_KIT_MAC_KEYCHAIN_PASSWORD : undefined;
  if (existsSync(keychain) && !password) throw new Error('The signing keychain already exists, but its password is missing from .env.mac-signing.local. Restore that file before rerunning setup.');
  if (!existsSync(keychain)) {
    password = randomBytes(32).toString('base64url');
    run('/usr/bin/security', ['create-keychain', '-p', password, keychain], 'Create signing keychain');
    // Retain access even if a later import or notarization authentication fails.
    env.CSC_KEYCHAIN = keychain;
    env.PI_KIT_MAC_KEYCHAIN_PASSWORD = password;
    save(env);
  }
  run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain], 'Unlock signing keychain');
  run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain], 'Set signing keychain timeout');
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain], 'Check installed signing identities');
  if (!identities.includes(cert.fingerprint.replaceAll(':', ''))) {
    run('/usr/bin/security', ['import', join(source, 'developer-id-application.p12'), '-k', keychain, '-T', '/usr/bin/codesign', '-T', '/usr/bin/productbuild', '-P', exportPassword], 'Import signing identity');
  }
  run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain], 'Allow CLI signing');
  const keychains = run('/usr/bin/security', ['list-keychains', '-d', 'user'], 'Read keychain list').split('\n').map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
  if (!keychains.includes(keychain)) run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain, ...keychains], 'Register signing keychain');
  console.log('Signing identity installed. Validating and saving notarization credentials in Keychain…');
  run('xcrun', ['notarytool', 'store-credentials', profileName, '--apple-id', appleId, '--team-id', team, '--password', notaryPassword, '--keychain', keychain], 'Save notarization credentials');
  const profile = join(destination, 'pi-kit.provisionprofile');
  copyFileSync(join(source, 'pi-kit.provisionprofile'), profile);
  chmodSync(profile, 0o600);
  chmodSync(keychain, 0o600);
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete env[key];
  Object.assign(env, { CSC_NAME: name.replace(/^Developer ID Application:\s*/, ''), CSC_KEYCHAIN: keychain, PI_KIT_MAC_KEYCHAIN_PASSWORD: password, APPLE_TEAM_ID: team, PI_KIT_MAC_PROVISIONING_PROFILE: profile, APPLE_KEYCHAIN_PROFILE: profileName, APPLE_KEYCHAIN: keychain, PI_KIT_NOTARIZE: '1' });
  save(env);
  console.log('This Mac is configured. Run: pnpm package:mac:signed');
} catch (error) {
  console.error(`macOS signing setup: ${error instanceof SyntaxError ? 'Could not parse the signing metadata or local configuration.' : error.message}`);
  process.exitCode = 1;
}
