import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import type { PlaybookCalendarSource, PlaybookMailSource, PlaybookSafeOutput, PlaybookTool } from '@pi-kit/protocol';
import { McpCallService } from '../mcp/mcp-call.service';
import { RoomSources } from './room-sources.service';
import type { Playbook } from './room-playbook-files.service';

export interface ToolRun {
  ok: boolean;
  output: string;
}

export interface ToolCall {
  argv?: string[];
  mcp?: { server: string; tool: string; args: Record<string, unknown> };
  mail?: PlaybookMailSource;
  calendar?: PlaybookCalendarSource;
}

@Injectable()
export class RoomPlaybookTools {
  static readonly OUTPUT_LIMIT = 48 * 1024;
  static readonly TIMEOUT = 90_000;
  static readonly BUFFER = 16 * 1024 * 1024;

  constructor(
    private readonly mcp: McpCallService,
    private readonly sources: RoomSources,
  ) {}

  output(playbook: Playbook, name: string): PlaybookSafeOutput | undefined {
    return playbook.config['safe-outputs'][name];
  }

  tool(playbook: Playbook, name: string): PlaybookTool {
    const tool = playbook.config.tools[name] ?? this.output(playbook, name);
    if (!tool) throw new Error(`The playbook has no tool or safe output named ${name}.`);
    return tool;
  }

  needs(playbook: Playbook, name: string): string[] {
    const connector = this.tool(playbook, name);
    const source = connector.run
      ? connector.run.join(' ')
      : JSON.stringify(connector.mcp?.args ?? connector.calendar ?? {});
    return [...new Set(source.match(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g) ?? [])]
      .map((match) => match.slice(1, -1))
      .filter((key) => !(key in playbook.config.vars) && key !== 'repository' && key !== 'room');
  }

  prepare(playbook: Playbook, name: string, params: Record<string, string>, context: Record<string, string>): ToolCall {
    const values: Record<string, string> = { ...context, ...playbook.config.vars, ...params };
    const fill = (part: string): string =>
      part.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key: string) => {
        const value = values[key];
        if (value === undefined) throw new Error(`The tool ${name} needs ${key}.`);
        return value;
      });
    const connector = this.tool(playbook, name);
    if (connector.mail) return { mail: connector.mail };
    if (connector.calendar)
      return {
        calendar: { ...connector.calendar, ...(connector.calendar.ics ? { ics: fill(connector.calendar.ics) } : {}) },
      };
    if (connector.mcp) {
      const args = JSON.parse(
        JSON.stringify(connector.mcp.args, (_, value: unknown) => (typeof value === 'string' ? fill(value) : value)),
      ) as Record<string, unknown>;
      return { mcp: { server: connector.mcp.server, tool: connector.mcp.tool, args } };
    }
    for (const [key, value] of Object.entries(params))
      if (value.startsWith('-')) throw new Error(`The value of ${key} may not start with a dash.`);
    return { argv: (connector.run ?? []).map(fill) };
  }

  callOf(payload: Record<string, unknown>): ToolCall {
    if (payload['mail']) return { mail: payload['mail'] as PlaybookMailSource };
    if (payload['calendar']) return { calendar: payload['calendar'] as PlaybookCalendarSource };
    const mcp = payload['mcp'] as ToolCall['mcp'] | undefined;
    if (mcp && typeof mcp.server === 'string' && typeof mcp.tool === 'string') return { mcp };
    return { argv: Array.isArray(payload['argv']) ? payload['argv'].map(String) : [] };
  }

  async run(cwd: string, call: ToolCall): Promise<ToolRun> {
    if (call.mcp) return await this.mcp.call(cwd, call.mcp.server, call.mcp.tool, call.mcp.args);
    if (call.mail) return await this.sources.mail(call.mail);
    if (call.calendar) return await this.sources.calendar(cwd, call.calendar);
    const [command, ...args] = call.argv ?? [];
    if (!command) return { ok: false, output: 'The connector names no command.' };
    return await new Promise((resolve) => {
      execFile(
        command,
        args,
        { cwd, timeout: RoomPlaybookTools.TIMEOUT, maxBuffer: RoomPlaybookTools.BUFFER, windowsHide: true },
        (error, stdout, stderr) => {
          const output = `${stdout}${error && stderr ? `\n${stderr}` : ''}`.trim();
          resolve(error ? { ok: false, output: output || error.message } : { ok: true, output });
        },
      );
    });
  }

  cut(text: string, limit = RoomPlaybookTools.OUTPUT_LIMIT): string {
    return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters cut)` : text;
  }

  page(text: string, page: number): string {
    const pages = Math.max(1, Math.ceil(text.length / RoomPlaybookTools.OUTPUT_LIMIT));
    if (pages === 1) return text;
    const at = Math.min(Math.max(1, page), pages);
    const slice = text.slice((at - 1) * RoomPlaybookTools.OUTPUT_LIMIT, at * RoomPlaybookTools.OUTPUT_LIMIT);
    return `${slice}\n\n(Page ${at} of ${pages}.${at < pages ? ` Call room_call again with the same connector and params and page ${at + 1} for more.` : ''})`;
  }

  items(output: string, key: readonly string[] | undefined): { key: string; item: unknown }[] {
    const parsed = JSON.parse(output) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((item) => ({
      item,
      key: key ? key.map((path) => String(this.pick(item, path) ?? '')).join('/') : JSON.stringify(item).slice(0, 500),
    }));
  }

  private pick(value: unknown, path: string): unknown {
    let current = value;
    for (const part of path.split('.')) {
      if (!current || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
