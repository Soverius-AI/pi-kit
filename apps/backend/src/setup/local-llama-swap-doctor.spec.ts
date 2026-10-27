import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectModels, repairModels } from './local-llama-swap-doctor';

/** The doctor names what keeps a config from running; Repair changes only the lines an issue names. */
describe('llama-swap config doctor', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pk-doctor-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const config = (launcher: string) => `# my engines
healthCheckTimeout: 90
models:
  fine: # keep me
    cmd: "'${launcher}' --model '${join(dir, 'fine.gguf')}' --port \${PORT}"
  gone:
    cmd: "'${launcher}' --model '${join(dir, 'gone.gguf')}' --port \${PORT}"
  custom:
    cmd: my-engine --weights /nowhere.bin
`;

  it('reports a missing model file and a missing launcher, and leaves custom launchers and macros alone', async () => {
    writeFileSync(join(dir, 'fine.gguf'), 'GGUF');
    const document = parseDocument(config('/opt/old/llama-server'));
    const issues = await inspectModels(document, { llamaServer: '/opt/new/llama-server' });
    expect(issues.map((issue) => [issue.kind, issue.model, issue.fixable])).toEqual([
      ['missing-launcher', 'fine', true],
      ['missing-file', 'gone', true],
    ]);
    expect(await inspectModels(parseDocument('models: {}'), {})).toMatchObject([{ kind: 'no-models', fixable: false }]);
    // Without an installed llama-server the launcher cannot be replaced; the issue says to edit it instead.
    expect((await inspectModels(document, {}))[0]).toMatchObject({ kind: 'missing-launcher', fixable: false });
  });

  it('removes entries without a file, replaces the launcher, and keeps comments and other lines', async () => {
    writeFileSync(join(dir, 'fine.gguf'), 'GGUF');
    const installed = join(dir, 'llama-server');
    writeFileSync(installed, '#!/bin/sh\n');
    const document = parseDocument(config('/opt/old/llama-server'));
    const changes = repairModels(document, await inspectModels(document, { llamaServer: installed }), installed);
    expect(changes).toEqual([`fine now starts ${installed}.`, 'Removed gone (its file is missing).']);
    const text = document.toString();
    expect(text).toContain('# my engines');
    expect(text).toContain('healthCheckTimeout: 90');
    expect(text).toContain('# keep me');
    expect(text).not.toContain('gone:');
    const after = parseDocument(text);
    expect(after.getIn(['models', 'fine', 'cmd'])).toBe(`'${installed}' --model '${join(dir, 'fine.gguf')}' --port \${PORT}`);
    expect(after.getIn(['models', 'custom', 'cmd'])).toBe('my-engine --weights /nowhere.bin');
    expect(await inspectModels(after, { llamaServer: installed })).toEqual([]);
  });
});
