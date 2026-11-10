// Started by durable.test.ts with the same clean environment the supervisor gives the worker.
import { createBashTool, type BashToolOptions } from '@earendil-works/pi-durable/tools';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { DurableSandbox } from '../../dist/durable.js';
import { DurableWorkerHandler } from '../../lib/durable-worker.js';

const cwd = process.argv[2];
if (!cwd) throw new Error('Missing fixture working directory');
const worker = DurableWorkerHandler.create(cwd);
const env = DurableSandbox.environment(
  {
    request: <T = unknown>(op: string, args: unknown[], options?: { signal?: AbortSignal }) =>
      worker.request(op, args, options) as Promise<T>,
  },
  { cwd, namespaceId: 'node:local', release: () => worker.close() },
);
const outputs: Awaited<ReturnType<ReturnType<typeof createBashTool>['execute']>>['structuredOutput'][] = [];
async function run(options?: BashToolOptions) {
  let output = '';
  const result = await createBashTool(options).execute(
    {
      command:
        'printf "%s:%s:%s" "${PI_SANDBOX_TEST_BACKEND_SECRET-unset}" "${WORKER_TOOL_FIXTURE-unset}" "${COMMAND_VALUE-unset}"',
    },
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
    context,
  );
  outputs.push(result.structuredOutput);
}
try {
  await run();
  await run({
    prepare: (execution) => {
      execution.env = { COMMAND_VALUE: 'explicit' };
    },
  });
  // argv, not a shell: shells synthesize PATH and friends even from an empty environment.
  let output = '';
  const result = await env.exec(
    [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
    {
      inheritEnv: false,
      env: { COMMAND_VALUE: 'isolated' },
      onOutput: (text) => {
        output += text;
      },
    },
    context,
  );
  if (!result.ok) throw result.error;
  process.stdout.write(JSON.stringify({ outputs, isolated: JSON.parse(output) }));
} finally {
  await env.cleanup(context);
}
