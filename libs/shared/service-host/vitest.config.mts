import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@pi-kit/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      '@pi-kit/api/generated': fileURLToPath(new URL('../api/src/generated/index.ts', import.meta.url)),
    },
  },
  test: { include: ['src/**/*.spec.ts'], environment: 'node' },
});
