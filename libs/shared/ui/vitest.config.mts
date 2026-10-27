import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@pi-kit/i18n/testing': fileURLToPath(new URL('../i18n/src/testing.ts', import.meta.url)),
      '@pi-kit/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      // The specs need the pure geometry (row heights), not the Angular components of the package: the alias points at that one file.
      '@pi-kit/design-system': fileURLToPath(new URL('../design-system/src/lib/graph-geometry.ts', import.meta.url)),
    },
  },
  test: { include: ['src/**/*.spec.ts'], environment: 'node' },
});
