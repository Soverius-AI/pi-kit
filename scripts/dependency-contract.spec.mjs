import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { FunctionCallSchema, DynamicValueSchema, scrapeSchemaBehavior } from '@a2ui/web_core/v0_9';

const require = createRequire(import.meta.url);

test('the SDKs resolve the same Zod 4 package as the application', () => {
  const root = require.resolve('zod');
  assert.equal(z.core.version.major, 4);
  for (const name of ['@copilotkit/angular', '@copilotkit/core', '@copilotkit/runtime', '@a2ui/web_core/v0_9', '@ag-ui/client', '@ag-ui/core', '@ag-ui/proto', 'zod-to-json-schema']) {
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
  const behavior = scrapeSchemaBehavior(z.object({ rows: DynamicValueSchema.optional(), labels: z.array(z.object({ text: DynamicValueSchema })) }));
  assert.equal(behavior.shape.rows.type, 'DYNAMIC');
  assert.equal(behavior.shape.labels.type, 'ARRAY');
  assert.equal(behavior.shape.labels.element.shape.text.type, 'DYNAMIC');
});

test('CopilotKit references local math fonts instead of embedding their bytes in JavaScript', () => {
  const source = readFileSync(require.resolve('@copilotkit/angular'), 'utf8');
  assert.ok(!source.includes('data:font/'));
  assert.ok(source.includes('/assets/katex/fonts/KaTeX_Main-Regular.woff2'));
});
