import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from '@earendil-works/chord/context';
import { createEnvConformance, type EnvConformanceAssertions } from '@earendil-works/pi-durable/testing';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { DurableSandbox } from '../dist/durable.js';
import { DurableWorkerHandler } from '../lib/durable-worker.js';

// Transport conformance in one process, not an SRT containment check; the smoke test below runs the real sandbox.
async function withEnv(use: (env: ExecutionEnv) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'durable-rpc-'));
  const worker = DurableWorkerHandler.create(cwd);
  const client = {
    request: <T = unknown>(op: string, args: unknown[], options?: { signal?: AbortSignal }) =>
      worker.request(op, structuredClone(args), options) as Promise<T>,
  };
  const env = DurableSandbox.environment(client, { cwd, namespaceId: 'node:local', release: () => worker.close() });
  try {
    await use(env);
  } finally {
    await env.cleanup(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
}
const assertions: EnvConformanceAssertions = {
  ...assert,
  greaterThan: (a, b) => assert.ok(a > b),
  partialDeepEqual: assert.partialDeepStrictEqual,
  rejects: async (p, text) => assert.rejects(p, (e) => String(e).includes(text)),
};
for (const spec of createEnvConformance({ assertions, withEnv }))
  test(
    spec.name,
    {
      skip: spec.name.startsWith('watch ') ? 'watchers are a typed not_supported: there is no event transport' : false,
      timeout: spec.timeoutMs ?? 20000,
    },
    spec.run,
  );

test('watch is a typed capability refusal', async () =>
  withEnv(async (env) => {
    const result = await env.watch([], () => undefined, ctx);
    assert.ok(!result.ok);
    assert.equal(result.error.name, 'FileError');
    assert.equal(result.error.code, 'not_supported');
  }));

test('cancelling one command leaves its sibling running', async () =>
  withEnv(async (env) => {
    const controller = new AbortController();
    const first = env.exec(['sh', '-c', 'sleep 5'], undefined, withAbortSignal(controller.signal, ctx));
    const sibling = env.exec(['sh', '-c', 'sleep .1; printf survivor'], undefined, ctx);
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const cancelled = await first;
    assert.ok(!cancelled.ok);
    assert.equal(cancelled.error.code, 'aborted');
    assert.ok(Date.now() - started < 2000, 'abort is delivered without waiting for the next poll');
    const survived = await sibling;
    assert.ok(survived.ok);
    assert.equal(survived.value.exitCode, 0);
  }));

test('streamed output arrives without per-poll latency', async () =>
  withEnv(async (env) => {
    const chunks: string[] = [];
    const started = Date.now();
    const result = await env.exec(
      ['sh', '-c', 'for i in 1 2 3 4 5; do printf "$i"; sleep .02; done'],
      { onOutput: (text) => void chunks.push(text) },
      ctx,
    );
    assert.ok(result.ok);
    assert.equal(chunks.join(''), '12345');
    assert.ok(Date.now() - started < 900, 'long poll returns as soon as output exists');
  }));

test('worker rejects unallowlisted operations and stale handles', async () => {
  const worker = DurableWorkerHandler.create(tmpdir());
  try {
    await assert.rejects(worker.request('durable.constructor', []), /Unsupported/);
    await assert.rejects(worker.request('durable.listFiles', ['.']), /Unsupported/);
    await assert.rejects(worker.request('execute', ['process.exit()']), /Invalid/);
    const stale = await worker.request('durable.handle', ['unknown', 'read', 0, 1]);
    assert.ok(stale && typeof stale === 'object' && 'error' in stale);
    assert.ok(stale.error && typeof stale.error === 'object' && 'code' in stale.error);
    assert.equal(stale.error.code, 'invalid');
  } finally {
    await worker.close();
  }
});

test(
  'content operations refuse FIFOs instead of blocking the worker',
  { skip: process.platform === 'win32' },
  async () =>
    withEnv(async (env) => {
      execFileSync('mkfifo', [join(env.cwd, 'pipe')]);
      for (const result of [
        await env.readTextFile('pipe', ctx),
        await env.readBinaryFile('pipe', ctx),
        await env.writeFile('pipe', 'x', ctx),
        await env.openTextLineReader('pipe', ctx),
      ]) {
        assert.ok(!result.ok);
        assert.equal(result.error.code, 'invalid');
      }
    }),
);

test('cwd is mutable per environment and each owner tears down independently', async () =>
  withEnv(async (first) =>
    withEnv(async (second) => {
      await second.createDir('sub', undefined, ctx);
      second.cwd = join(second.cwd, 'sub');
      const write = await second.writeFile('inside.txt', 'yes', ctx);
      assert.equal(write.ok, true);
      const sibling = second.exec(['sh', '-c', 'sleep .05; printf ok'], undefined, ctx);
      await first.cleanup(ctx);
      const survived = await sibling;
      assert.ok(survived.ok);
      assert.equal(survived.value.exitCode, 0);
      const read = await second.readTextFile('inside.txt', ctx);
      assert.ok(read.ok);
      assert.equal(read.value, 'yes');
    }),
  ));

test('durable createBashTool inherits the clean worker environment, never backend secrets', async () => {
  const [{ execFile }, { promisify }, { SandboxPolicy }, { fileURLToPath }] = await Promise.all([
    import('node:child_process'),
    import('node:util'),
    import('../lib/policy.js'),
    import('node:url'),
  ]);
  const cwd = await mkdtemp(join(tmpdir(), 'durable-tool-bootstrap-'));
  const source = { ...process.env, PI_SANDBOX_TEST_BACKEND_SECRET: 'host-only-secret' };
  const workerEnv = { ...SandboxPolicy.cleanEnv(source, { cwd, temp: cwd }), WORKER_TOOL_FIXTURE: 'sanitized-worker' };
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/durable-tool-worker.js', import.meta.url)), cwd],
      { env: workerEnv },
    );
    const report = JSON.parse(stdout) as {
      outputs: { output: string; exitCode: number }[];
      isolated: Record<string, string | undefined>;
    };
    assert.equal(report.outputs[0].output, 'unset:sanitized-worker:unset');
    assert.equal(report.outputs[0].exitCode, 0);
    assert.equal(report.outputs[1].output, 'unset:sanitized-worker:explicit');
    assert.equal(report.isolated.COMMAND_VALUE, 'isolated');
    for (const name of ['PATH', 'HOME', 'WORKER_TOOL_FIXTURE', 'PI_SANDBOX_TEST_BACKEND_SECRET'])
      assert.equal(report.isolated[name], undefined);
    assert.ok(!stdout.includes(source.PI_SANDBOX_TEST_BACKEND_SECRET));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test(
  'real SRT: durable createBashTool default and explicit environment stay confined',
  { skip: process.env.PI_SANDBOX_SMOKE !== '1', timeout: 60000 },
  async () => {
    const [{ Sandbox }, { createBashTool }, { realpath }] = await Promise.all([
      import('../dist/core.js'),
      import('@earendil-works/pi-durable/tools'),
      import('node:fs/promises'),
    ]);
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'durable-srt-tool-')));
    const previous = process.env.PI_SANDBOX_TEST_BACKEND_SECRET;
    process.env.PI_SANDBOX_TEST_BACKEND_SECRET = 'host-only-secret';
    let env: ExecutionEnv | undefined;
    try {
      const client = await Sandbox.create({
        cwd,
        experimentalWindowsAccepted: process.env.PI_SANDBOX_WINDOWS_ACCEPT === '1',
      });
      env = DurableSandbox.environment(client, { cwd, namespaceId: 'node:local', release: () => client.close() });
      let output = '';
      const result = await createBashTool().execute(
        { command: 'printf "%s:%s" "${PI_SANDBOX_TEST_BACKEND_SECRET-unset}" "${PATH:+worker-path}"' },
        {
          env,
          output: (text) => {
            output += text;
          },
          retainedOutput: () => ({ text: output, truncated: false }),
          diagnostic: () => undefined,
        } satisfies Pick<
          Parameters<ReturnType<typeof createBashTool>['execute']>[1],
          'env' | 'output' | 'retainedOutput' | 'diagnostic'
        > as unknown as Parameters<ReturnType<typeof createBashTool>['execute']>[1],
        ctx,
      );
      assert.ok(
        result.structuredOutput &&
          typeof result.structuredOutput === 'object' &&
          !Array.isArray(result.structuredOutput),
      );
      assert.equal(result.structuredOutput.output, 'unset:worker-path');
      assert.equal(result.structuredOutput.exitCode, 0);
      let explicit = '';
      const command = await env.exec(
        [
          process.execPath,
          '-e',
          'process.stdout.write(process.env.COMMAND_VALUE+":"+(process.env.PI_SANDBOX_TEST_BACKEND_SECRET??"unset"))',
        ],
        {
          env: { COMMAND_VALUE: 'explicit' },
          inheritEnv: true,
          onOutput: (text) => {
            explicit += text;
          },
        },
        ctx,
      );
      assert.equal(command.ok, true);
      assert.equal(explicit, 'explicit:unset');
    } finally {
      if (previous === undefined) delete process.env.PI_SANDBOX_TEST_BACKEND_SECRET;
      else process.env.PI_SANDBOX_TEST_BACKEND_SECRET = previous;
      await env?.cleanup(ctx);
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
