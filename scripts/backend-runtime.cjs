// Files that cannot be folded into the backend's JavaScript bundle.
// macOS-only, self-contained native loader and prebuilds, provisioned per target.
exports.optionalNativePackages = ['keychain-store'];
exports.nativePackages = ['@appthreat/sqlite3', '@napi-rs/keyring', 'node-pty', 'sharp'];
// Optional framework branches we do not use. Keep their imports external so
// Nest's existing optional-load handling still sees a missing package.
exports.optionalImports = [
  '@nestjs/microservices',
  '@nestjs/websockets',
  '@fastify/static',
  'class-transformer/storage',
  // Baileys optional peers, absent from the install: audio waveform generation,
  // a fallback image engine (Sharp is staged), and outgoing link previews.
  'audio-decode',
  'jimp',
  'link-preview-js',
  // ws catches missing optional native accelerators and uses its JS fallback.
  'bufferutil',
  'utf-8-validate',
];

// Preserve package boundaries: the ESM driver imports pool/worker files and its
// native loader resolves node-gyp-build relative to the original package.
// Sharp also resolves its platform package relative to its own loader. Preserve
// both entry formats and its JavaScript dependencies, then select target binaries.
exports.packageCopyClosure = [
  '@appthreat/sqlite3',
  'node-gyp-build',
  'node-addon-api',
  'sharp',
  '@img/colour',
  'detect-libc',
  'semver',
];
