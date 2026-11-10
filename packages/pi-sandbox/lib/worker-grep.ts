import { createGrepToolDefinition } from '@earendil-works/pi-coding-agent/dist/core/tools/grep.js';

/** pi's own grep, run in the worker so ripgrep reads only what the sandbox allows. The host's grep tool forwards here. */
export class WorkerGrep {
  static async run(params: object, cwd: string, signal: AbortSignal): Promise<unknown> {
    const tool = createGrepToolDefinition(cwd);
    const { content, details } = await tool.execute(
      'grep',
      params as Parameters<typeof tool.execute>[1],
      signal,
      undefined,
      { cwd } as Parameters<typeof tool.execute>[4],
    );
    return { content, details };
  }
}
