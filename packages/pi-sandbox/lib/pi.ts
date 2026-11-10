// No runtime pi import: the host passes its installed SDK in, so there is never a second pi copy.
import { StringDecoder } from 'node:string_decoder';
import { SandboxError } from './protocol.js';
import { ProcessTree } from './process-tree.js';
import type { SandboxClient } from './core.js';
import type {
  AgentToolUpdateCallback,
  BashOperations,
  BashToolDetails,
  EditOperations,
  LsOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';

export interface PiSandboxOptions {
  client: SandboxClient;
  cwd: string;
  assertCurrent: () => void;
}

export interface PiOperations {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  bash: BashOperations;
  ls: LsOperations;
  request: <T = unknown>(operation: string, args: unknown[], signal?: AbortSignal) => Promise<T>;
}

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
interface WorkerStat {
  size: number;
  mode: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
interface CommandRun {
  exitCode: number | null;
  buffer: Buffer;
  error?: unknown;
}

export class PiSandbox {
  private static readonly OUTPUT_LIMIT = 4 * 1024 * 1024;
  /** pi's own cap for `structuredContent.output`, which programmatic callers receive. */
  private static readonly STRUCTURED_OUTPUT_LIMIT = 1024 * 1024;

  static operations(options: PiSandboxOptions): PiOperations {
    const client = () => {
      options.assertCurrent();
      if (options.client.state !== 'active')
        throw new SandboxError(options.client.reason || 'Sandbox unavailable; host fallback refused');
      return options.client;
    };
    const request = async <T = unknown>(operation: string, args: unknown[], signal?: AbortSignal): Promise<T> =>
      client().request<T>(operation, args, { signal });
    const read: ReadOperations = {
      readFile: (p) => request<Buffer>('readFile', [p]),
      access: async (p) => {
        await request<void>('access', [p, 4]);
      },
      detectImageMimeType: async (p) => {
        const b = await request<Buffer>('readFile', [p, { length: 12 }]);
        if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
        if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
        if (/^GIF8[79]a/.test(b.subarray(0, 6).toString())) return 'image/gif';
        if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
        return null;
      },
    };
    const write: WriteOperations = {
      writeFile: async (p, content) => {
        await request<void>('writeFile', [p, content]);
      },
      mkdir: async (p) => {
        await request<void>('mkdir', [p, { recursive: true }]);
      },
    };
    const edit: EditOperations = {
      readFile: read.readFile,
      writeFile: write.writeFile,
      access: async (p) => {
        await request<void>('access', [p, 6]);
      },
    };
    const bash: BashOperations = { exec: async (command, cwd, opts) => client().exec(command, cwd, opts) };
    const ls: LsOperations = {
      exists: async (p) => {
        try {
          await request<void>('access', [p]);
          return true;
        } catch (e) {
          if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') return false;
          throw e;
        }
      },
      stat: async (p) => {
        const s = await request<WorkerStat>('stat', [p]);
        return { ...s, isDirectory: () => s.isDirectory };
      },
      readdir: (p) => request<string[]>('readdir', [p]),
    };
    return { read, write, edit, bash, ls, request };
  }

  static toolDefinitions(sdk: PiSdk, options: PiSandboxOptions): ToolDefinition[] {
    const ops = PiSandbox.operations(options);
    const cwd = options.cwd;
    const edit = sdk.createEditToolDefinition(cwd, { operations: ops.edit });
    // pi's edit preview reads the target from the host filesystem once arguments complete; keep the renderer, skip that read.
    const renderEditCall = edit.renderCall;
    if (renderEditCall)
      edit.renderCall = (args, theme, context) => renderEditCall(args, theme, { ...context, argsComplete: false });
    const bashBase = sdk.createBashToolDefinition(cwd, { operations: ops.bash, exposeSessionEnvironment: false });
    const bash: ReturnType<PiSdk['createBashToolDefinition']> = {
      ...bashBase,
      description:
        bashBase.description +
        ' Sandbox output is bounded to 4 MiB; spill files live only in the confined worker and expire when the sandbox closes.',
      async execute(_id, args, signal, onUpdate, ctx) {
        const started = performance.now();
        const run = await PiSandbox.collect(ops, args.command, ctx?.cwd || cwd, signal, args.timeout, onUpdate);
        const truncation = sdk.truncateTail(run.buffer.toString('utf8'));
        const code = (run.error as { code?: unknown } | undefined)?.code;
        if (code === 'ABORT_ERR') throw new Error(PiSandbox.status(truncation.content, 'Command aborted'));
        if (code === 'TIMEOUT')
          throw new Error(PiSandbox.status(truncation.content, `Command timed out after ${args.timeout} seconds`));
        if (run.error) throw run.error;
        if (run.exitCode === null)
          throw new Error(PiSandbox.status(truncation.content, 'Command terminated without an exit code'));
        const artifact = truncation.truncated
          ? await ops.request<string>('artifact.write', [run.buffer], signal)
          : undefined;
        let output = truncation.content || '(no output)';
        if (artifact) output += `\n\n[Output truncated. Full output: ${artifact}]`;
        const structured = PiSandbox.structuredOutput(run.buffer);
        const structuredContent = {
          output: structured.content,
          truncated: structured.truncated,
          ...(structured.truncated && artifact ? { full_output_path: artifact } : {}),
          exit_code: run.exitCode,
          wall_time_seconds: Math.round((performance.now() - started) / 100) / 10,
        };
        const details = artifact ? { truncation, fullOutputPath: artifact } : undefined;
        if (run.exitCode !== 0)
          return {
            content: [{ type: 'text', text: PiSandbox.status(output, `Command exited with code ${run.exitCode}`) }],
            details,
            structuredContent,
            isError: true,
          };
        return { content: [{ type: 'text', text: output }], details, structuredContent };
      },
    };
    const find = sdk.createFindToolDefinition(cwd, {
      operations: {
        exists: ops.ls.exists,
        async glob(pattern, root, { ignore, limit }) {
          const command = PiSandbox.rg([
            '--files',
            '--null',
            '--hidden',
            '--glob',
            pattern,
            ...ignore.flatMap((p) => ['--glob', `!${p}`]),
            '--',
            root,
          ]);
          const run = PiSandbox.searched(await PiSandbox.collect(ops, command, root));
          return run.buffer.toString().split('\0').filter(Boolean).slice(0, limit);
        },
      },
    });
    const grepBase = sdk.createGrepToolDefinition(cwd);
    const grep: typeof grepBase = {
      ...grepBase,
      execute: (_id, params, signal, _onUpdate, ctx) =>
        options.client.request<Awaited<ReturnType<typeof grepBase.execute>>>('pi.grep', [params, ctx?.cwd || cwd], {
          signal,
        }),
    };
    // Admission runs before every tool, including host-side steps (pi's read path probes) that precede any request.
    const guard = <TParams extends TSchema, TDetails, TState>(definition: ToolDefinition<TParams, TDetails, TState>) =>
      sdk.defineTool({
        ...definition,
        async execute(...args: Parameters<typeof definition.execute>) {
          options.assertCurrent();
          return definition.execute(...args);
        },
      });
    const definitions: ToolDefinition[] = [
      guard(sdk.createReadToolDefinition(cwd, { operations: ops.read })),
      guard(sdk.createWriteToolDefinition(cwd, { operations: ops.write })),
      guard(edit),
      guard(bash),
      // Like pi's own ls, find and grep: on only when the defaultTools setting names them.
      guard({ ...sdk.createLsToolDefinition(cwd, { operations: ops.ls }), defaultActive: false }),
      guard({ ...find, defaultActive: false }),
      guard({ ...grep, defaultActive: false }),
    ];
    if (process.platform === 'win32') definitions.push(guard({ ...bash, name: 'powershell', label: 'powershell' }));
    return definitions;
  }

  private static async collect(
    ops: PiOperations,
    command: string,
    cwd: string,
    signal?: AbortSignal,
    timeout?: number,
    onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>,
  ): Promise<CommandRun> {
    const buffers: Buffer[] = [];
    let length = 0;
    let exceeded = false;
    let preview = '';
    const decoder = new StringDecoder('utf8');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let run: CommandRun;
    try {
      const result = await ops.bash.exec(command, cwd, {
        signal: controller.signal,
        timeout,
        onData(b) {
          length += b.length;
          if (length > PiSandbox.OUTPUT_LIMIT) {
            exceeded = true;
            controller.abort();
            return;
          }
          buffers.push(b);
          preview = (preview + decoder.write(b)).slice(-50000);
          onUpdate?.({ content: [{ type: 'text', text: preview }], details: undefined });
        },
      });
      run = { exitCode: result.exitCode, buffer: Buffer.concat(buffers) };
    } catch (error) {
      run = { exitCode: null, buffer: Buffer.concat(buffers), error };
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    if (exceeded)
      throw new SandboxError(
        'Command output exceeded 4 MiB; command cancelled, side effects may have completed. Do not automatically replay.',
        'OUTPUT_LIMIT',
      );
    return run;
  }

  /** rg exits 1 for "no matches"; anything else means the search did not run. */
  private static searched(run: CommandRun): CommandRun {
    if (run.error) throw run.error;
    if (run.exitCode !== 0 && run.exitCode !== 1)
      throw new SandboxError(run.buffer.toString() || 'Sandbox rg is unavailable', 'SEARCH_UNAVAILABLE');
    return run;
  }

  private static rg(args: string[]): string {
    return (process.platform === 'win32' ? '& ' : '') + ['rg', ...args].map(ProcessTree.shellQuote).join(' ');
  }

  private static status(text: string, status: string): string {
    return `${text ? `${text}\n\n` : ''}${status}`;
  }

  /** Mirrors pi: the head and tail of oversized output, cut on UTF-8 character boundaries. */
  private static structuredOutput(buffer: Buffer): { content: string; truncated: boolean } {
    const limit = PiSandbox.STRUCTURED_OUTPUT_LIMIT;
    if (buffer.length <= limit) return { content: buffer.toString('utf8'), truncated: false };
    const headBytes = Math.floor(limit / 2);
    const head = new StringDecoder('utf8').write(buffer.subarray(0, headBytes));
    let tailStart = buffer.length - (limit - headBytes);
    while (tailStart < buffer.length && (buffer[tailStart] & 0xc0) === 0x80) tailStart++;
    const omitted = buffer.length - limit;
    return {
      content: `${head}\n\n[... ${omitted} bytes omitted ...]\n\n${buffer.subarray(tailStart).toString('utf8')}`,
      truncated: true,
    };
  }
}
