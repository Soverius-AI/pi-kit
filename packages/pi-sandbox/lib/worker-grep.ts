import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createGrepToolDefinition } from '@earendil-works/pi-coding-agent/dist/core/tools/grep.js';

/** pi's own grep, run in the worker so ripgrep reads only what the sandbox allows. The host's grep tool forwards here. */
export class WorkerGrep {
  static async run(params: object, cwd: string, signal: AbortSignal): Promise<unknown> {
    const tool = createGrepToolDefinition(cwd);
    const search = params as Parameters<typeof tool.execute>[1];
    const { content, details } = await tool.execute(
      'grep',
      // pi's grep takes one glob, so a caller's own replaces this one.
      search.glob ? search : { ...search, glob: await WorkerGrep.unreadable(cwd) },
      signal,
      undefined,
      { cwd } as Parameters<typeof tool.execute>[4],
    );
    return { content, details };
  }

  /** ripgrep fails a whole search on an unreadable entry: denied .env files, or the /dev/null bwrap binds over a missing node_modules. */
  private static async unreadable(cwd: string): Promise<string> {
    const names = ['.env', '.env.*'];
    const modules = await stat(path.join(cwd, 'node_modules')).catch(() => undefined);
    if (modules && !modules.isDirectory()) names.push('node_modules');
    return `!{${names.join(',')}}`;
  }
}
