import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';
import { IpcChannel, SandboxError } from '../lib/protocol.js';
import { SandboxPolicy } from '../lib/policy.js';
import { Sandbox, type SandboxClient } from '../dist/core.js';
import { PiSandbox } from '../dist/pi.js';

type Message = { type: string; [key: string]: unknown };
const noop = () => undefined;

test('invalid options are refused before any process starts, with confirmed cleanup', async () => {
  await assert.rejects(Sandbox.create({ cwd: 'relative' }), { code: 'INVALID_ARGUMENT', cleanupConfirmed: true });
  await assert.rejects(Sandbox.create({ cwd: '/workspace[*]' }), { code: 'INVALID_ARGUMENT' });
});

test('the home directory and its ancestors are not workspaces', () => {
  const home = os.homedir();
  for (const cwd of [home, path.dirname(home), path.parse(home).root])
    assert.throws(() => SandboxPolicy.validate({ cwd }), { code: 'INVALID_ARGUMENT' }, cwd);
  SandboxPolicy.validate({ cwd: path.join(home, 'project') });
  SandboxPolicy.validate({ cwd: `${home}-sibling` });
});

test('protected paths are bounded in count and total size', () => {
  assert.throws(
    () =>
      SandboxPolicy.validate({
        cwd: '/workspace',
        protectedPaths: ['/' + 'a'.repeat(32000), '/' + 'b'.repeat(32000), '/' + 'c'.repeat(32000)],
      }),
    { code: 'INVALID_ARGUMENT' },
  );
  assert.throws(() => SandboxPolicy.validate({ cwd: '/workspace', protectedPaths: ['relative'] }), {
    code: 'INVALID_ARGUMENT',
  });
});

test('caller environment is allowlisted; tokens, hooks, PATH and HOME never pass', () => {
  const source = {
    PATH: '/evil',
    LANG: 'en_US.UTF-8',
    API_KEY: 'secret',
    PI_BACKEND_TOKEN: 'secret',
    BASH_ENV: '/evil',
    NODE_OPTIONS: '--import evil',
    LD_PRELOAD: '/evil',
    JAVA_TOOL_OPTIONS: 'evil',
    HTTPS_PROXY: 'evil',
    HOME: '/home/secret',
  };
  assert.deepEqual(SandboxPolicy.pickEnv(source), { LANG: 'en_US.UTF-8' });
  const env = SandboxPolicy.cleanEnv(source, { temp: '/scope-temp', cwd: '/workspace' });
  for (const key of [
    'API_KEY',
    'PI_BACKEND_TOKEN',
    'BASH_ENV',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'JAVA_TOOL_OPTIONS',
    'HTTPS_PROXY',
  ])
    assert.equal(env[key], undefined);
  assert.notEqual(env.PATH, '/evil');
  assert.equal(env.HOME, '/scope-temp');
  assert.equal(env.PWD, '/workspace');
});

test('Electron Node mode is a controlled literal, not forwarded host environment', () => {
  assert.equal(SandboxPolicy.cleanEnv({ ELECTRON_RUN_AS_NODE: 'evil' }).ELECTRON_RUN_AS_NODE, undefined);
  Object.defineProperty(process.versions, 'electron', { value: 'test', configurable: true });
  try {
    const env = SandboxPolicy.cleanEnv({ ELECTRON_RUN_AS_NODE: 'evil', ELECTRON_NO_ASAR: '1' });
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(env.ELECTRON_NO_ASAR, undefined);
  } finally {
    delete process.versions.electron;
  }
});

const helpers = {
  seccomp: '/helpers/apply-seccomp',
  srtWin: 'C:\\helpers\\srt-win.exe',
  javaAgent: '/helpers/agent.jar',
};

test('compiled policy: workspace and temp writes only, empty network allowlist, credential denies', () => {
  const policy = SandboxPolicy.compile(
    { cwd: '/workspace', protectedPaths: ['/trusted/state'] },
    '/private/scope-temp',
    helpers,
  );
  assert.deepEqual(policy.network.allowedDomains, []);
  assert.equal(policy.network.strictAllowlist, true);
  assert.equal(policy.network.allowAllUnixSockets, false);
  assert.deepEqual(
    policy.filesystem.allowWrite.map((entry) => (typeof entry === 'object' ? entry.path : entry)),
    ['/workspace', '/private/scope-temp'],
  );
  const denied = (policy.credentials?.files ?? []).filter((f) => f.mode === 'deny').map((f) => f.path);
  for (const p of ['/workspace/.env', '/trusted/state', path.join(os.homedir(), '.ssh')])
    assert.ok(denied.includes(p), p);
  const writeDenied = policy.filesystem.denyWrite.map((entry) => (typeof entry === 'object' ? entry.path : entry));
  for (const p of ['/trusted/state', '/workspace/node_modules', '/workspace/.env'])
    assert.ok(writeDenied.includes(p), p);
  assert.equal(policy.seccomp?.applyPath, helpers.seccomp);
  assert.equal(policy.windows?.srtWin?.path, helpers.srtWin);
  assert.equal(policy.javaAgentJarPath, helpers.javaAgent);
  assert.equal(SandboxPolicy.compile({ cwd: '/workspace' }, '/private/scope-temp', {}).seccomp, undefined);
});

test('a runtime inside a protected path fails fast instead of starting an unreadable worker', () => {
  const installed = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  assert.throws(
    () => SandboxPolicy.compile({ cwd: '/workspace', protectedPaths: [installed] }, '/private/scope-temp', helpers),
    { code: 'RUNTIME_PROTECTED', message: /is inside the protected path/ },
  );
});

test('IPC preserves binary bytes, reassembles split frames and splits coalesced ones', async () => {
  const wire = new PassThrough();
  const received: Message[] = [];
  new IpcChannel<Message, Message>(
    wire,
    new PassThrough(),
    (m) => received.push(m),
    (e) => assert.fail(String(e)),
  );
  const frame = (message: Message) => {
    const body = serialize(message);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    return Buffer.concat([header, body]);
  };
  const bytes = Buffer.concat([frame({ type: 'a', data: Buffer.from([0, 255, 1]) }), frame({ type: 'b' })]);
  for (const byte of bytes.subarray(0, 7)) wire.write(Buffer.from([byte]));
  wire.write(bytes.subarray(7));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    received.map((m) => m.type),
    ['a', 'b'],
  );
  assert.deepEqual(received[0].data, Buffer.from([0, 255, 1]));
  const send = new IpcChannel<Message, Message>(new PassThrough(), new PassThrough(), noop, noop);
  await assert.rejects(send.send({ type: 'data', data: Buffer.alloc(IpcChannel.MAX_FRAME) }), { code: 'IPC_LIMIT' });
});

test('IPC rejects an oversized frame header before allocating its body', () => {
  const input = new PassThrough();
  let error: unknown;
  new IpcChannel<Message, Message>(
    input,
    new PassThrough(),
    () => assert.fail('message dispatched'),
    (e) => (error = e),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(IpcChannel.MAX_FRAME + 1);
  input.write(header);
  assert.ok(error instanceof SandboxError);
  assert.equal(error.code, 'PROTOCOL_ERROR');
});

test('the grep tool keeps pi’s definition, is off by default and runs pi’s grep in the worker', async () => {
  const seen: [string, unknown[]][] = [];
  const result = { content: [{ type: 'text', text: 'a.ts:1: hit' }], details: undefined };
  const client = {
    state: 'active',
    request: async <T = unknown>(op: string, args: unknown[]): Promise<T> => {
      seen.push([op, args]);
      return result as T;
    },
    exec: async () => ({ exitCode: 0 }),
    close: async () => undefined,
  } satisfies SandboxClient;
  const sdk = await import('@earendil-works/pi-coding-agent');
  const grep = PiSandbox.toolDefinitions(sdk, { client, cwd: '/workspace', assertCurrent: noop }).find(
    (tool) => tool.name === 'grep',
  );
  assert.ok(grep);
  assert.equal(grep.defaultActive, false);
  assert.equal(grep.description, sdk.createGrepToolDefinition('/workspace').description);
  const params = { pattern: 'hit', path: 'src' };
  assert.deepEqual(await grep.execute('1', params, undefined, undefined, { cwd: '/workspace/sub' } as never), result);
  assert.deepEqual(seen, [['pi.grep', [params, '/workspace/sub']]]);
});

test('pi operations route through the client, sniff images with a bounded read and refuse an inactive client', async () => {
  const seen: [string, unknown[]][] = [];
  let active = true;
  let admissions = 0;
  const client: SandboxClient = {
    get state() {
      return active ? 'active' : 'unavailable';
    },
    request: async <T = unknown>(op: string, args: unknown[]): Promise<T> => {
      seen.push([op, args]);
      const value = op === 'readFile' ? Buffer.from('hello') : op === 'stat' ? { isDirectory: true } : undefined;
      return value as T;
    },
    exec: async () => ({ exitCode: 0 }),
    close: async () => undefined,
  };
  const ops = PiSandbox.operations({ client, cwd: '/workspace', assertCurrent: () => void admissions++ });
  assert.equal((await ops.read.readFile('/workspace/a')).toString(), 'hello');
  assert.equal(await ops.read.detectImageMimeType?.('/workspace/a'), null);
  await ops.write.mkdir('/workspace/a');
  await ops.edit.writeFile('/workspace/a', 'x');
  assert.equal((await ops.ls.stat('/workspace')).isDirectory(), true);
  assert.deepEqual(seen, [
    ['readFile', ['/workspace/a']],
    ['readFile', ['/workspace/a', { length: 12 }]],
    ['mkdir', ['/workspace/a', { recursive: true }]],
    ['writeFile', ['/workspace/a', 'x']],
    ['stat', ['/workspace']],
  ]);
  assert.equal(admissions, 5);
  active = false;
  await assert.rejects(ops.read.readFile('/etc/passwd'), /unavailable/);
  await assert.rejects(ops.bash.exec('touch /tmp/unsafe', '/', { onData: noop }), /unavailable/);
});
