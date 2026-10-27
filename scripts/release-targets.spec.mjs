import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arch, getArchSuffix, getArtifactArchName } from 'builder-util';
import { createRequire } from 'node:module';
import { assertLinuxHost, releaseTargets, selectTargets } from './release-targets.mjs';

test('Linux defaults to the native architecture and preserves the macOS/Windows defaults elsewhere', () => {
  assert.deepEqual(selectTargets(undefined, 'linux', 'arm64'), ['linux-arm64']);
  assert.deepEqual(selectTargets(['linux'], 'linux', 'x64'), ['linux-x64']);
  assert.deepEqual(selectTargets(undefined, 'darwin', 'arm64'), ['mac', 'win-x64', 'win-arm64']);
  assert.deepEqual(selectTargets(['win,linux-arm64', 'win-x64'], 'linux', 'arm64'), ['win-x64', 'win-arm64', 'linux-arm64']);
});

test('Linux source builds fail before packaging on a different OS or CPU', () => {
  assert.doesNotThrow(() => assertLinuxHost(['linux-arm64'], 'linux', 'arm64'));
  assert.doesNotThrow(() => assertLinuxHost(['darwin-arm64', 'win32-x64'], 'darwin', 'arm64'));
  assert.throws(() => assertLinuxHost(['linux-x64'], 'linux', 'arm64'), /matching Linux host/);
  assert.throws(() => assertLinuxHost(['linux-arm64'], 'darwin', 'arm64'), /matching Linux host/);
});

test('Linux feeds match electron-updater channel names for each CPU', () => {
  const require = createRequire(import.meta.url);
  const { Provider } = require('electron-updater/out/providers/Provider.js');
  const targets = releaseTargets('1.2.3');
  const saved = process.env.TEST_UPDATER_ARCH;
  try {
    for (const arch of ['x64', 'arm64']) {
      process.env.TEST_UPDATER_ARCH = arch;
      const provider = new Provider({ platform: 'linux' });
      const target = targets[`linux-${arch}`];
      assert.equal(target.updateInfo, `${provider.getCustomChannelName('latest')}.yml`);
      assert.deepEqual(target.artifacts, [`pi-kit-1.2.3-linux-${getArtifactArchName(Arch[arch], 'AppImage')}.AppImage`]);
      assert.notEqual(targets['linux-x64'].unpacked, targets['linux-arm64'].unpacked);
    }
  } finally {
    if (saved === undefined) delete process.env.TEST_UPDATER_ARCH;
    else process.env.TEST_UPDATER_ARCH = saved;
  }
});

test('Linux output folders match electron-builder architecture suffixes', () => {
  const targets = releaseTargets('1.2.3');
  for (const arch of ['x64', 'arm64']) {
    assert.equal(targets[`linux-${arch}`].unpacked, `linux${getArchSuffix(Arch[arch])}-unpacked`);
  }
});
