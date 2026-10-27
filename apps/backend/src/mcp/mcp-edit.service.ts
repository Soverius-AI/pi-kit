import { existsSync, readFileSync } from 'node:fs';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type McpActionResult,
  type McpFile,
  type McpFilePut,
  type McpFileSaved,
  type McpScope,
  type McpServerBody,
  type McpServerCreate,
  type McpServerDetail,
  buildServerEntry,
  checkMcpFile,
  describeProblem,
  isProviderAccount,
  serverDetailOf,
  storedAccountsOf,
} from '@pi-kit/protocol';
import { PiSessionService } from '../pi/pi-session.service';
import { TrustService } from '../pi/trust.service';
import { SecretsService } from '../secrets/secrets.service';
import { ThreadsService } from '../threads/threads.service';
import { fileMtime, projectMcpConfigPath, readMcpEntry, removeMcpServer, userMcpConfigPath, writeMcpServer, writeTextAtomically } from './mcp-config';
import { McpService } from './mcp.service';

/**
 * Changing MCP servers and `mcp.json` from inside the app: the details form's three routes, and the file editor's two. Both write exactly what pi reads
 * (docs/mcp.md) and let pi do the rest: the session reloads, and a new URL server without a token starts its sign-in. A header or environment value that looks like a secret goes
 * to the credential store and the file gets the command that prints it; with no store it is written as it is, in the user's file only, and the answer says so.
 */
@Injectable()
export class McpEditService {
  constructor(
    private readonly sessions: PiSessionService,
    private readonly threads: ThreadsService,
    private readonly mcp: McpService,
    private readonly secrets: SecretsService,
    private readonly trust: TrustService,
  ) {}

  // ---- the details form

  /** The form of a server, prefilled from the file that defines it. */
  async detail(threadId: string | undefined, name: string, scope: McpScope | undefined): Promise<McpServerDetail> {
    const scopes: McpScope[] = scope ? [scope] : threadId ? ['project', 'user'] : ['user'];
    for (const candidate of scopes) {
      const path = await this.path(candidate, threadId);
      const raw = readMcpEntry(path, name);
      if (raw) return serverDetailOf(name, candidate, path, raw);
    }
    throw new NotFoundException(`No MCP server "${name}" is in ${scope === 'project' ? 'the project’s' : 'the user’s'} mcp.json.`);
  }

  async create(threadId: string | undefined, body: McpServerCreate): Promise<McpActionResult> {
    const { scope, ...form } = body;
    const path = await this.writablePath(scope, threadId);
    if (readMcpEntry(path, form.name)) throw new ConflictException(`${path} has a server named “${form.name}” already. Pick another name, or edit that one.`);
    const notes: string[] = [];
    const { entry, plain } = await this.build(form, undefined, scope);
    this.noteplain(plain, notes);
    if (threadId) this.requireIdle(threadId);
    this.write(path, form.name, entry);
    const added = `Added ${form.name} to ${path}.`;
    if (!threadId) return { message: [added, 'Open a thread to connect it: pi connects servers when a session starts.', ...notes].join(' '), overview: await this.mcp.overview() };
    await this.sessions.reload(threadId);
    if (form.enabled && form.kind === 'url' && !hasAuthorization(entry) && entry['auth'] === undefined) {
      try {
        const login = await this.mcp.login(threadId, form.name);
        return { message: [added, login.message, ...notes].filter(Boolean).join(' '), ...(login.url ? { url: login.url } : {}), overview: login.overview };
      } catch (error) {
        notes.push(`The sign-in did not start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { message: [added, ...notes].join(' '), overview: await this.mcp.overview(threadId) };
  }

  /** Saves the form over the entry of `name` in the file of `scope`. A different `body.name` moves the entry. */
  async update(threadId: string | undefined, name: string, scope: McpScope, body: McpServerBody): Promise<McpActionResult> {
    const path = await this.writablePath(scope, threadId);
    const existing = readMcpEntry(path, name);
    if (!existing) throw new NotFoundException(`${path} does not define “${name}” any more. Reload the list.`);
    const renamed = body.name !== name;
    if (renamed && readMcpEntry(path, body.name)) throw new ConflictException(`${path} has a server named “${body.name}” already.`);
    const notes: string[] = [];
    const { entry, plain } = await this.build(body, existing, scope);
    this.noteplain(plain, notes);
    if (threadId) this.requireIdle(threadId);
    this.write(path, body.name, entry);
    if (renamed) {
      removeMcpServer(path, name);
      this.mcp.forgetSignIn(threadId ?? '', name);
    }
    // A header or variable that is not read from the store any more (removed, or typed over) takes its stored value with it.
    const still = new Set(storedAccountsOf(entry));
    for (const account of storedAccountsOf(existing)) if (!still.has(account) && isProviderAccount(account)) await this.secrets.forget(account);
    const saved = renamed ? `Saved ${name} as ${body.name} in ${path}.` : `Saved ${name} in ${path}.`;
    if (!threadId) return { message: [saved, ...notes].join(' '), overview: await this.mcp.overview() };
    await this.sessions.reload(threadId);
    return { message: [saved, ...notes].join(' '), overview: await this.mcp.overview(threadId) };
  }

  // ---- the file editor

  async readFile(threadId: string | undefined, scope: McpScope): Promise<McpFile> {
    const path = await this.path(scope, threadId);
    const exists = existsSync(path);
    return { scope, path, text: exists ? readFileSync(path, 'utf8') : '', mtime: exists ? fileMtime(path) : 0, exists };
  }

  /** Saves the editor's text: valid for pi, and the file as it was when the editor opened it. Then the session reads it again. */
  async writeFile(threadId: string | undefined, scope: McpScope, body: McpFilePut): Promise<McpFileSaved> {
    const path = await this.path(scope, threadId);
    const check = checkMcpFile(body.text, scope);
    if (!check.ok) throw new BadRequestException(describeProblem(check.problems[0]));
    if (fileMtime(path) !== body.mtime) throw new ConflictException('The file changed since you opened it. Reload and try again.');
    writeTextAtomically(path, body.text);
    let message = `Saved ${path}.`;
    if (threadId) {
      if (this.sessions.stats(threadId).streaming) message += ' The thread is running; use Reload on this page when it has finished, so pi reads the file again.';
      else {
        await this.sessions.reload(threadId);
        message += ' The servers connect again.';
      }
    }
    return { file: await this.readFile(threadId, scope), message, overview: await this.mcp.overview(threadId) };
  }

  // ---- internals

  private async path(scope: McpScope, threadId: string | undefined): Promise<string> {
    return scope === 'user' ? userMcpConfigPath(await this.sessions.agentDir()) : this.mcp.filePath('project', threadId);
  }

  /** The file to write: the project's only for a thread in a folder pi trusts (it would not read the file otherwise). */
  private async writablePath(scope: McpScope, threadId: string | undefined): Promise<string> {
    if (scope === 'user') return this.path('user', threadId);
    if (!threadId) throw new ConflictException('Open a thread in the folder first: “This project” writes that folder’s .pi/mcp.json.');
    await this.threads.openSession(threadId);
    const cwd = this.threads.cwdOf(threadId);
    if (!(await this.trust.folderTrusted(cwd))) throw new ConflictException('This folder is not trusted yet, so pi would not read its .pi/mcp.json. Trust the folder first.');
    return projectMcpConfigPath(cwd);
  }

  /** The entry for the form. A secret in a project file is refused (credentials stay in the user file, docs/mcp.md); elsewhere it goes to the store. */
  private async build(form: McpServerBody, existing: Record<string, unknown> | undefined, scope: McpScope): Promise<{ entry: Record<string, unknown>; plain: string[] }> {
    if (scope === 'project') {
      const probe = buildServerEntry(form, existing, () => 'probe');
      if (probe.stored.length > 0) throw new BadRequestException('A header or variable with a secret stays in your user file; “This project” is for servers without credentials. Use ${NAME} to read it from the environment.');
    }
    const values = new Map<string, string>();
    buildServerEntry(form, existing, (account, value) => {
      values.set(account, value);
      return undefined;
    });
    const resolvers = new Map<string, string>();
    for (const [account, value] of values) {
      if (!isProviderAccount(account)) continue;
      const kept = await this.secrets.keep(account, value);
      if (kept.storage === 'keychain') resolvers.set(account, kept.value);
    }
    const built = buildServerEntry(form, existing, (account) => resolvers.get(account));
    return { entry: built.entry, plain: built.plain };
  }

  private noteplain(plain: string[], notes: string[]): void {
    if (plain.length > 0) notes.push(`Protected credential storage is disabled or unavailable, so ${plain.join(', ')} ${plain.length === 1 ? 'is' : 'are'} in mcp.json as plain text (readable by you only).`);
  }

  private write(path: string, name: string, entry: Record<string, unknown>): void {
    try {
      writeMcpServer(path, name, entry);
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
  }

  private requireIdle(threadId: string): void {
    if (this.sessions.stats(threadId).streaming) throw new ConflictException('Stop the run first: pi reloads the session to see the change.');
  }
}

const hasAuthorization = (entry: Record<string, unknown>): boolean => {
  const headers = entry['headers'];
  return typeof headers === 'object' && headers !== null && Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
};
