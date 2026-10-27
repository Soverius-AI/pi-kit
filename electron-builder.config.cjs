// electron-builder configuration. `pnpm run release` (scripts/release.mjs) builds, stages dist/package (the shell) and
// dist/stage/<platform>-<arch>/backend (scripts/package-stage.mjs), then runs electron-builder against them, once per platform
// (`scripts/package.mjs <mac|win|linux>`); the architectures come from the command line.
//
// Layout of the packed app:
//   Resources/app.asar        desktop/{main,preload}.cjs, splash.html, icon.png and renderer/browser (the shell)
//   Resources/backend/        main.js (Nest + CopilotKit bundled), migrations/, packages/, assets/{pi,needle}, pi-kit-secret.cjs
//                             and node_modules/ (built native loaders + binaries for the target's architecture), staged from
//                             Nx production outputs and copied by scripts/builder-after-pack.cjs
// The backend is an extra resource, not part of the asar: it is started with ELECTRON_RUN_AS_NODE from there, and the native
// modules, spawn-helper and pi's asset files (themes, export-html template, schemas, docs) are plain files on disk.

const { macSigningOptions, macSigningIdentity } = require('./scripts/mac-signing.cjs');
const { notarizationEnabled, afterSign, notarizeArtifact } = require('./scripts/mac-notarization.cjs');

const signingIdentity = macSigningIdentity();
const notarize = notarizationEnabled();

// electron-builder's classic NSIS (3.0.4.1) and rcedit/signing tools are x86-64 programs: on an Apple Silicon Mac without Rosetta they
// cannot start (it never got past makensis for that reason). Its newer "toolsets" (still labelled beta by electron-builder) ship native
// arm64 macOS builds, so that is what a Mac like that uses; every other host (the Windows runner in CI) keeps the classic tools.
// PI_KIT_TOOLSETS=classic|beta forces either.
const toolsetChoice = process.env.PI_KIT_TOOLSETS || (process.platform === 'darwin' && process.arch === 'arm64' ? 'beta' : 'classic');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.pi-kit.app',
  forceCodeSigning: process.env.PI_KIT_BUILD_PLATFORM === 'darwin' && Boolean(process.env.CSC_NAME || process.env.CSC_LINK),
  productName: 'pi-kit',
  copyright: `Copyright © ${new Date().getFullYear()} Soverius.AI GmbH`,
  electronVersion: require('./node_modules/electron/package.json').version,
  // Reuse the Electron the workspace already runs (pnpm run dev) instead of downloading a second copy; cross builds fall back to the download.
  // (Only when the one target is this machine's platform and CPU: a Windows or an Intel build always uses its own download.)
  ...(process.env.PI_KIT_BUILD_PLATFORM === process.platform && process.env.PI_KIT_BUILD_ARCHS === process.arch ? { electronDist: 'node_modules/electron/dist' } : {}),
  directories: { app: 'dist/package', output: 'dist/release', buildResources: 'apps/desktop/build' },
  asar: true,
  // Keep Chromium's built-in messages in the supported UI languages only.
  electronLanguages: ['en', 'en-US', 'en-GB', 'de'],
  files: ['**/*', '!backend/**', '!**/node_modules/**'],
  // Resources/backend is copied by the afterPack hook: `extraResources` never copies a folder named node_modules.
  afterPack: 'scripts/builder-after-pack.cjs',
  afterSign,
  artifactBuildCompleted: notarizeArtifact,
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  icon: 'apps/desktop/build/icon.png',
  ...(toolsetChoice === 'beta' ? { toolsets: { nsis: '1.2.1', winCodeSign: '1.1.0' } } : {}),
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // pi-kit's own updates: electron-updater reads the `app-update.yml` this writes into the packed app and looks for
  // releases of this GitHub repository. `PI_KIT_UPDATE_REPO=owner/name` points a build elsewhere.
  publish: [{ provider: 'github', owner: (process.env.PI_KIT_UPDATE_REPO || 'wolfmanfx/pi-kit').split('/')[0], repo: (process.env.PI_KIT_UPDATE_REPO || 'wolfmanfx/pi-kit').split('/')[1] }],

  mac: {
    category: 'public.app-category.developer-tools',
    // The architecture comes from the command line (`scripts/package.mjs` passes --arm64 or --x64), because the staged backend holds one platform's natives.
    // The dmg is what people download; electron-updater updates a mac app from the zip (and latest-mac.yml) next to it.
    target: ['dmg', 'zip'],
    hardenedRuntime: true,
    // Voice input: the text macOS shows in its microphone prompt.
    extendInfo: { NSMicrophoneUsageDescription: 'pi-kit listens to your microphone only while you dictate a message. The audio is turned into text on this Mac and is not sent anywhere.' },
    gatekeeperAssess: false,
    ...macSigningOptions(),
    // Signing: set CSC_NAME (a "Developer ID Application: ..." identity in the keychain) or CSC_LINK/CSC_KEY_PASSWORD (a .p12).
    // Without either the app is ad-hoc signed ("-"), which is what Apple Silicon needs to run a locally built copy at all;
    // it is not distributable.
    identity: signingIdentity === undefined ? undefined : signingIdentity === null ? '-' : signingIdentity,
    // PI_KIT_NOTARIZE=1 requires complete credentials; the app and DMG get stapled tickets and Gatekeeper checks.
    notarize,
  },
  dmg: {
    title: '${productName} ${version}',
    sign: notarize,
  },

  linux: {
    target: 'AppImage',
    category: 'Development',
    synopsis: 'A desktop UI for the pi coding agent',
    maintainer: 'pi-kit',
  },

  // pi-kit-<version>-win-<arch>.exe is the installer (it is what electron-updater downloads, latest.yml lists it), -portable.exe the
  // single-file build for a USB stick or a folder you cannot install into. Unsigned unless WIN_CSC_LINK (or CSC_LINK) and its password are set.
  // The architecture comes from the command line (--x64 --arm64), as on macOS.
  win: {
    target: ['nsis', 'portable'],
  },
  portable: {
    artifactName: '${productName}-${version}-${os}-${arch}-portable.${ext}',
    // As for the installer: one file per architecture, not an extra combined one (the option belongs to the NSIS target, which portable shares).
    buildUniversalInstaller: false,
  },
  nsis: {
    // Native process checks work without PowerShell/tasklist, including in CrossOver bottles.
    include: 'apps/desktop/build/installer.nsh',
    // One installer per architecture: with the default, building x64 and arm64 together would make a single combined installer.
    buildUniversalInstaller: false,
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
};
