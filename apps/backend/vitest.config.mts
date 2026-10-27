import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const lib = (name: string) => fileURLToPath(new URL(`../../libs/shared/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: { alias: { '@pi-kit/protocol': lib('protocol'), '@pi-kit/pi-adapter': lib('pi-adapter'), '@pi-kit/secret-store': lib('secret-store') } },
  test: { include: ['src/**/*.spec.ts'], environment: 'node' },
});
