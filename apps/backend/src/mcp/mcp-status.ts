import type { McpExposure, McpState } from '@pi-kit/protocol';

/** What pi's `/mcp` command prints for one server (pi 1.2.0, `formatStatus` in its MCP extension). */
export interface McpServerStatus {
  state: McpState;
  exposure: McpExposure;
  tools?: number;
  /** The connection error pi shows under the line (indented by four spaces). */
  error?: string;
}

export interface McpStatusReport {
  servers: Map<string, McpServerStatus>;
  /** `config error: ...` lines. */
  configErrors: string[];
  /** `overridden: ...` lines (an extension's server hidden by a file entry). */
  notes: string[];
}

const LINE = /^([A-Za-z0-9_-]+): (.+) \((codemode|deferred|direct|hidden)\)$/;

function stateOf(text: string): Pick<McpServerStatus, 'state' | 'tools'> {
  if (text.startsWith('needs sign-in')) return { state: 'needs-auth' };
  if (text === 'disabled') return { state: 'disabled' };
  if (text.startsWith('disconnected')) return { state: 'disconnected' };
  if (text.startsWith('failed')) return { state: 'failed' };
  if (text.startsWith('closed')) return { state: 'closed' };
  if (text.startsWith('connected')) {
    const tools = /, (\d+) tools?/.exec(text);
    return { state: 'connected', ...(tools ? { tools: Number(tools[1]) } : {}) };
  }
  // `connecting` and `starting` (the connection has not been created yet).
  return { state: 'connecting' };
}

/**
 * Parses the status text of `/mcp` outside the TUI. pi has no API for its connection states (they live in the MCP
 * extension's closure), and this text is what it documents as the status output (docs/mcp.md, "Inspect or change a
 * server"). The grammar is pinned to pi 1.2.0 by the unit test; a line it does not understand is ignored, so a
 * newer pi degrades to `unknown` states instead of wrong ones.
 */
export function parseMcpStatus(text: string): McpStatusReport {
  const report: McpStatusReport = { servers: new Map(), configErrors: [], notes: [] };
  let last: McpServerStatus | undefined;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('    ') && last) {
      last.error = [last.error, raw.slice(4)].filter((line) => line !== undefined).join('\n');
      continue;
    }
    last = undefined;
    const line = raw.trim();
    if (line.startsWith('config error: ')) {
      report.configErrors.push(line.slice('config error: '.length));
      continue;
    }
    if (line.startsWith('overridden: ')) {
      report.notes.push(line.slice('overridden: '.length));
      continue;
    }
    const match = LINE.exec(line);
    if (!match) continue;
    const status: McpServerStatus = { ...stateOf(match[2]), exposure: match[3] as McpExposure };
    report.servers.set(match[1], status);
    last = status;
  }
  return report;
}
