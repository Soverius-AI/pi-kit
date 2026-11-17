import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { FunctionCallSchema, DynamicValueSchema, MessageProcessor, scrapeSchemaBehavior } from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/web_core/v0_9/basic_catalog';

const require = createRequire(import.meta.url);

test('the SDKs share the upgraded AG-UI transport and A2UI implementation', () => {
  for (const name of ['@copilotkit/angular', '@copilotkit/core', '@copilotkit/runtime']) {
    const sdkRequire = createRequire(require.resolve(name));
    assert.equal(sdkRequire.resolve('@ag-ui/client'), require.resolve('@ag-ui/client'), name);
  }
  const angularRequire = createRequire(require.resolve('@copilotkit/angular'));
  const coreRequire = createRequire(require.resolve('@copilotkit/core'));
  for (const sdkRequire of [angularRequire, coreRequire]) {
    assert.equal(sdkRequire.resolve('@a2ui/web_core/v0_9'), require.resolve('@a2ui/web_core/v0_9'));
  }
});

test('AG-UI retains the enlarged SSE and protobuf limits in both builds', () => {
  const entry = require.resolve('@ag-ui/client');
  for (const path of [entry, entry.replace(/index\.js$/, 'index.mjs')]) {
    const source = readFileSync(path, 'utf8');
    assert.equal(source.match(/512\*1024\*1024/g)?.length, 2, path);
    assert.ok(!source.includes('10*1024*1024'), path);
  }
});

test('the SDKs resolve the same Zod 4 package as the application', () => {
  const root = require.resolve('zod');
  assert.equal(z.core.version.major, 4);
  for (const name of [
    '@copilotkit/angular',
    '@copilotkit/core',
    '@copilotkit/runtime',
    '@a2ui/web_core/v0_9',
    '@ag-ui/client',
    '@ag-ui/core',
    '@ag-ui/proto',
    'zod-to-json-schema',
  ]) {
    assert.equal(createRequire(require.resolve(name)).resolve('zod'), root, `${name} must share the application's Zod`);
  }
});

test('legacy converter entry points preserve Zod 4 property validation', () => {
  const result = zodToJsonSchema(z.object({ name: z.string(), count: z.number().min(1) }));
  assert.equal(result.properties.name.type, 'string');
  assert.equal(result.properties.count.minimum, 1);
  assert.deepEqual(result.required, ['name', 'count']);
});

test('A2UI function arguments use Zod 4 record semantics', () => {
  assert.deepEqual(FunctionCallSchema.parse({ call: 'format', args: { name: 'Ada' } }).args, { name: 'Ada' });
});

test('A2UI recognizes data bindings and nested properties in Zod 4 schemas', () => {
  const behavior = scrapeSchemaBehavior(
    z.object({ rows: DynamicValueSchema.optional(), labels: z.array(z.object({ text: DynamicValueSchema })) }),
  );
  assert.equal(behavior.shape.rows.type, 'DYNAMIC');
  assert.equal(behavior.shape.labels.type, 'ARRAY');
  assert.equal(behavior.shape.labels.element.shape.text.type, 'DYNAMIC');
});

test('A2UI serializes the v0.9 catalog with native Zod 4 conversion', () => {
  const processor = new MessageProcessor([basicCatalog]);
  assert.ok(processor.getClientCapabilities()['v0.9']);
});

test('CopilotKit references local math fonts instead of embedding their bytes in JavaScript', () => {
  const source = readFileSync(require.resolve('@copilotkit/angular'), 'utf8');
  assert.ok(!source.includes('data:font/'));
  assert.ok(source.includes('/assets/katex/fonts/KaTeX_Main-Regular.woff2'));
});

test('native async SQLite remains pinned and outside the CJS backend bundle', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies['@appthreat/sqlite3'], '9.1.0');
  const runtime = require('./backend-runtime.cjs');
  assert.ok(runtime.nativePackages.includes('@appthreat/sqlite3'));
  for (const name of ['better-sqlite3', 'better-sqlite3-multiple-ciphers']) {
    assert.equal(manifest.dependencies[name], undefined, `${name} must not be a runtime dependency`);
    assert.ok(!runtime.nativePackages.includes(name), `${name} must not be staged`);
  }
  const project = JSON.parse(readFileSync(new URL('../apps/backend-runtime/project.json', import.meta.url), 'utf8'));
  const native = project.targets['bundle-natives'].options;
  assert.ok(![native.main, ...native.additionalEntryPoints].some((path) => path.includes('@appthreat/sqlite3')));
  for (const name of runtime.packageCopyClosure)
    assert.ok(
      native.assets.some((asset) => asset.input === `node_modules/${name}` && asset.output === name),
      name,
    );
  assert.equal(JSON.parse(readFileSync(require.resolve('@appthreat/sqlite3/package.json'), 'utf8')).type, 'module');
});
