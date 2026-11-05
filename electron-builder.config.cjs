// electron-builder configuration. `pnpm run release` (scripts/release.mjs) builds, stages dist/package (the shell) and
// dist/stage/<platform>-<arch>/backend (scripts/package-stage.mjs), then runs electron-builder against them, once per platform
// (`scripts/package.mjs <mac|win|linux>`); the architectures come from the command line.
//
// Layout of the packed app:
//   Resources/app.asar        desktop/{main,preload}.cjs, splash.html, icon.png and renderer/browser (the shell)
//   Resources/backend/        main.js (Nest + CopilotKit bundled), service-host.cjs (runs main.js), migrations/, packages/,
//                             assets/{pi,needle}, pi-kit-secret.cjs, pi-kit.cjs (the `pi-kit service` command)
//                             and node_modules/ (built native loaders + binaries for the target's architecture), staged from
//                             Nx production outputs and copied by scripts/builder-after-pack.cjs
// The backend is an extra resource, not part of the asar: it is started with ELECTRON_RUN_AS_NODE from there, and the native
// modules, spawn-helper and pi's asset files (themes, export-html template, schemas, docs) are plain files on disk.

const { macSigningOptions, macSigningIdentity } = require('./scripts/mac-signing.cjs');
const { notarizationEnabled, afterSign, notarizeArtifact } = require('./scripts/mac-notarization.cjs');

const signingIdentity = macSigningIdentity();
const notarize = notarizationEnabled();

// electron-builder's classic NSIS and rcedit/signing tools are x86-64 only and do not start on Apple Silicon without Rosetta; its beta
// "toolsets" ship arm64 builds. Other hosts keep the classic tools. PI_KIT_TOOLSETS=classic|beta forces either.
const toolsetChoice =
  process.env.PI_KIT_TOOLSETS || (process.platform === 'darwin' && process.arch === 'arm64' ? 'beta' : 'classic');
const [updateOwner, updateRepo] = (process.env.PI_KIT_UPDATE_REPO || 'Soverius-AI/pi-kit').split('/');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.pi-kit.app',
  forceCodeSigning:
    process.env.PI_KIT_BUILD_PLATFORM === 'darwin' && Boolean(process.env.CSC_NAME || process.env.CSC_LINK),
  productName: 'pi-kit',
  copyright: `Copyright © ${new Date().getFullYear()} Soverius.AI GmbH`,
  electronVersion: require('./node_modules/electron/package.json').version,
  // Reuse the workspace's Electron when the only target is this machine's platform and CPU; other builds download their own.
  ...(process.env.PI_KIT_BUILD_PLATFORM === process.platform && process.env.PI_KIT_BUILD_ARCHS === process.arch
    ? { electronDist: 'node_modules/electron/dist' }
    : {}),
  directories: { app: 'dist/package', output: 'dist/release', buildResources: 'apps/desktop/build' },
  asar: true,
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
  // Written into the packed app as app-update.yml: electron-updater reads releases of this repository, so it must be public.
  // CI sets PI_KIT_UPDATE_REPO to the repository it builds in.
  publish: [{ provider: 'github', owner: updateOwner, repo: updateRepo }],

  mac: {
    // Apple's encoder avoids the corrupted small Finder icon from automatic PNG-to-ICNS conversion.
    // Regenerate on macOS with `pnpm run build:mac-icon` when icon.png changes.
    icon: 'apps/desktop/build/icon.icns',
    category: 'public.app-category.developer-tools',
    // The architecture comes from the command line (`scripts/package.mjs` passes --arm64 or --x64), because the staged backend holds one platform's natives.
    // The dmg is what people download; electron-updater updates a mac app from the zip (and latest-mac.yml) next to it.
    target: ['dmg', 'zip'],
    hardenedRuntime: true,
    extendInfo: {
      NSMicrophoneUsageDescription:
        'pi-kit listens to your microphone only while you dictate a message. The audio is turned into text on this Mac and is not sent anywhere.',
    },
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

  // The installer is what electron-updater downloads (latest.yml lists it); the portable build cannot update itself.
  // Unsigned unless WIN_CSC_LINK (or CSC_LINK) and its password are set. Architectures come from the command line, as on macOS.
  win: {
    target: ['nsis', 'portable'],
  },
  portable: {
    artifactName: '${productName}-${version}-${os}-${arch}-portable.${ext}',
    // One file per architecture; the option is shared with the NSIS target.
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
