// Files that cannot be folded into the backend's JavaScript bundle.
// macOS-only, self-contained native loader and prebuilds, provisioned per target.
exports.optionalNativePackages = ['keychain-store'];
exports.nativePackages = ['@napi-rs/keyring', 'better-sqlite3-multiple-ciphers', 'node-pty'];
// Optional framework branches we do not use. Keep their imports external so
// Nest's existing optional-load handling still sees a missing package.
exports.optionalImports = ['@nestjs/microservices', '@nestjs/websockets', '@fastify/static', 'class-transformer/storage'];
