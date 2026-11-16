import { describe, expect, it, vi } from 'vitest';
import {
  type CommandOptions,
  createMcpTransport,
  type DeferrableTransport,
  DeferredTransport,
  expandHome,
  resolveConfigValue,
} from './mcp-transport';
import { McpTap } from '../mcp/mcp-tap';

describe('resolveConfigValue', () => {
  it('substitutes environment variables and fails clearly on a missing one', () => {
    expect(resolveConfigValue('Bearer ${TOKEN}', 'h', { TOKEN: 'abc' })).toBe('Bearer abc');
    expect(() => resolveConfigValue('${NOPE}', 'MCP server "x" env "K"', {})).toThrow(
      'MCP server "x" env "K": the environment variable NOPE is not set.',
    );
  });

  it('runs a command only when it makes up the whole value', () => {
    expect(resolveConfigValue('!echo hi', 'h', {}, (c) => `ran ${c}\n`)).toBe('ran echo hi');
    expect(resolveConfigValue('a !echo hi', 'h', {}, () => 'x')).toBe('a !echo hi');
    expect(() =>
      resolveConfigValue('!boom', 'h', {}, () => {
        throw new Error('exit 1');
      }),
    ).toThrow('the command boom failed: exit 1');
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/ only', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/bin/x', '/h')).toBe('/h/bin/x');
    expect(expandHome('~x', '/h')).toBe('~x');
  });
});

describe('createMcpTransport', () => {
  const classes = {
    StdioTransport: class {
      constructor(public options: unknown) {}
    },
    StreamableHttpTransport: class {
      constructor(public options: unknown) {}
    },
  };

  it('builds a stdio transport relative to the session folder', () => {
    const t = createMcpTransport(
      classes,
      { name: 's', config: { command: 'node', args: ['a.js'], cwd: 'srv', env: { A: 'b' } } },
      '/work',
      undefined,
    ) as { options: Record<string, unknown> };
    expect(t).toBeInstanceOf(classes.StdioTransport);
    expect(t.options).toMatchObject({
      command: 'node',
      args: ['a.js'],
      cwd: '/work/srv',
      env: { A: 'b' },
      stderr: 'pipe',
    });
  });

  it('builds a streamable HTTP transport with the auth provider', () => {
    const auth = { token: () => 'x' };
    const t = createMcpTransport(
      classes,
      { name: 'h', config: { url: 'https://x/mcp', headers: { 'X-Y': 'z' } } },
      '/work',
      auth,
    ) as { options: Record<string, unknown> };
    expect(t).toBeInstanceOf(classes.StreamableHttpTransport);
    expect(t.options).toMatchObject({ url: 'https://x/mcp', headers: { 'X-Y': 'z' }, authProvider: auth });
  });
});

describe('MCP settings that run a command', () => {
  const made: FakeTransport[] = [];
  class FakeTransport {
    readonly messages = new Set<(message: never) => void>();
    readonly closes = new Set<() => void>();
    started = false;
    version: string | undefined;
    stderr = '';
    constructor(public options: Record<string, unknown>) {
      made.push(this);
    }
    async start(): Promise<void> {
      this.started = true;
    }
    async send(): Promise<void> {
      return undefined;
    }
    async close(): Promise<void> {
      for (const listener of this.closes) listener();
    }
    onMessage(listener: (message: never) => void): () => void {
      this.messages.add(listener);
      return () => this.messages.delete(listener);
    }
    onError(): () => void {
      return () => undefined;
    }
    onClose(listener: () => void): () => void {
      this.closes.add(listener);
      return () => this.closes.delete(listener);
    }
    setProtocolVersion(version: string): void {
      this.version = version;
    }
  }
  const classes = { StdioTransport: FakeTransport, StreamableHttpTransport: FakeTransport };

  it('regression: resolves a !command header when the server starts, never while the session opens', async () => {
    made.length = 0;
    let finish!: (value: string) => void;
    const run = vi.fn((command: string) => (void command, new Promise<string>((resolve) => (finish = resolve))));
    const transport = createMcpTransport(
      classes,
      {
        name: 'h',
        config: { url: 'https://x/mcp', headers: { Authorization: '!pi-kit-secret get connector-x --bearer' } },
      },
      '/work',
      undefined,
      run,
    ) as unknown as DeferrableTransport;
    expect(made).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    const seen: unknown[] = [];
    transport.onMessage((message) => seen.push(message));
    transport.setProtocolVersion?.('2025-06-18');
    const starting = transport.start();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        'pi-kit-secret get connector-x --bearer',
        expect.objectContaining({ timeoutMs: 60_000 }),
      ),
    );
    finish('Bearer abc\n');
    await starting;
    expect(made[0].options).toMatchObject({ url: 'https://x/mcp', headers: { Authorization: 'Bearer abc' } });
    expect(made[0].started).toBe(true);
    expect(made[0].version).toBe('2025-06-18');
    for (const listener of made[0].messages) listener({ id: 1 } as never);
    expect(seen).toEqual([{ id: 1 }]);
  });

  it('a failing command fails the start and names the setting it belongs to', async () => {
    const transport = createMcpTransport(
      classes,
      { name: 's', config: { command: 'node', env: { TOKEN: '!boom' } } },
      '/work',
      undefined,
      async () => {
        throw new Error('exit 1');
      },
    ) as unknown as DeferrableTransport;
    await expect(transport.start()).rejects.toThrow('MCP server "s" env "TOKEN": the command boom failed: exit 1');
  });

  it('regression: a deferred stdio transport stays a StdioTransport with its stderr through the tap', async () => {
    made.length = 0;
    const transport = new McpTap().wrap(
      's',
      createMcpTransport(
        classes,
        { name: 's', config: { command: 'node', env: { TOKEN: '!get' } } },
        '/work',
        undefined,
        async () => 'v',
      ) as unknown as DeferrableTransport,
    );
    expect(transport).toBeInstanceOf(FakeTransport);
    expect(transport.stderr).toBe('');
    await transport.start();
    made[0].stderr = 'boom\n';
    expect(transport.stderr).toBe('boom\n');
  });

  it('a deferred HTTP transport is not taken for a stdio one', () => {
    const transport = createMcpTransport(
      classes,
      { name: 'h', config: { url: 'https://x/mcp', headers: { Authorization: '!get' } } },
      '/work',
      undefined,
      async () => 'v',
    );
    expect(transport).toBeInstanceOf(DeferredTransport);
  });

  it("gives the command the server's own timeout", async () => {
    const run = vi.fn(async () => 'v');
    const transport = createMcpTransport(
      classes,
      { name: 't', config: { command: 'node', env: { TOKEN: '!get' }, timeout: 5 } },
      '/work',
      undefined,
      run,
    ) as unknown as DeferrableTransport;
    await transport.start();
    expect(run).toHaveBeenCalledWith('get', expect.objectContaining({ timeoutMs: 5000 }));
  });

  it('closing the transport stops a command that is still running', async () => {
    let signal: AbortSignal | undefined;
    const run = vi.fn(
      (_command: string, options: CommandOptions) =>
        new Promise<string>((_resolve, reject) => {
          signal = options.signal;
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const transport = createMcpTransport(
      classes,
      { name: 'c', config: { command: 'node', env: { TOKEN: '!wait' } } },
      '/work',
      undefined,
      run,
    ) as unknown as DeferrableTransport;
    const starting = transport.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    await transport.close();
    expect(signal?.aborted).toBe(true);
    await expect(starting).rejects.toThrow('The MCP transport was closed before it started.');
  });

  it('runs the command through the shell without blocking', async () => {
    const options = { timeoutMs: 5000, signal: new AbortController().signal };
    expect((await DeferredTransport.run('echo hi', options)).trim()).toBe('hi');
  });

  it('kills the command when it is aborted', async () => {
    const stop = new AbortController();
    const running = DeferredTransport.run(`"${process.execPath}" -e "setTimeout(() => {}, 30000)"`, {
      timeoutMs: 60_000,
      signal: stop.signal,
    });
    stop.abort();
    await expect(running).rejects.toThrow();
  });
});
