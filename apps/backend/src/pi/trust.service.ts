import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import type { TrustDecision, TrustList, TrustSource, TrustState } from '@pi-kit/protocol';
import type { LoadExtensionsResult, ProjectTrustContext } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { loadPi } from './load-pi';
import { scanTrustResources, trustDigest } from './trust-scan';

type Trusted = 'yes' | 'no' | 'undecided';

/**
 * Test-only escape hatch: `PI_KIT_TRUSTED_CWDS`, a list of folders separated by the path delimiter
 * (`:`, `;` on Windows), marks them trusted without a dialog and without writing pi's `trust.json`. It is
 * ignored when `NODE_ENV` is `production` (the desktop app), and logs a warning every time it is used.
 */
export function overrideTrusts(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['NODE_ENV'] === 'production') return false;
  const trusted = (env['PI_KIT_TRUSTED_CWDS'] ?? '').split(delimiter).filter(Boolean);
  return trusted.some((dir) => cwd === dir || cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep));
}

/**
 * Project trust with pi's own order of precedence (docs/security.md): a `project_trust` handler of
 * a user-level extension, then the decision saved in `trust.json` (the closest folder wins), then `defaultProjectTrust`
 * (`always` / `never`, default `ask`). "Ask" is what pi's TUI answers with a prompt and what pi-kit answers with
 * the trust dialog: the renderer asks for the state before it opens a thread, shows the dialog while it is `ask`,
 * and sends the answer to `decide()`. Only then does a session open, so project resources load after the answer.
 *
 * An answer is one of: skip (this app run only, nothing saved, asked again next launch), once (trusted until the app
 * quits), remember / never (saved in pi's `trust.json`, for the CLI as well).
 */
@Injectable()
export class TrustService {
  private readonly logger = new Logger(TrustService.name);
  /** Answers for this app run: `skip` is `false`, `once` is `true`. */
  private readonly session = new Map<string, boolean>();
  /** What user-level extensions said about a folder (they are loaded once per folder for the dialog). */
  private readonly probed = new Map<string, Promise<{ trusted: Trusted; remember: boolean }>>();
  /** Which project a folder is a thread worktree; set by the worktree service. */
  private worktreeOwner: ((path: string) => string | undefined) | undefined;

  /** Registers the lookup from a worktree folder to the project it belongs to. */
  useWorktrees(owner: (path: string) => string | undefined): void {
    this.worktreeOwner = owner;
  }

  /**
   * The folder whose answer counts for `cwd`: a thread's worktree inherits the trust of the project's main checkout, but only while the two hold the same
   * project resources (the same `.pi` files with the same content), so a worktree whose branch changed an extension asks on its own.
   */
  private async canonical(cwd: string): Promise<string> {
    const project = this.worktreeOwner?.(cwd);
    if (!project || project === cwd) return cwd;
    return (await this.sameResources(project, cwd)) ? project : cwd;
  }

  /** Whether two folders hold the same project resources, byte for byte; a folder that cannot be fingerprinted (a resource directory cycle) is nobody's twin. */
  private async sameResources(a: string, b: string): Promise<boolean> {
    try {
      const [left, right] = await Promise.all([trustDigest(a), trustDigest(b)]);
      return left === right;
    } catch {
      return false;
    }
  }

  /**
   * A scratch worktree of a verification run is trusted for this app run when it holds nothing a person has not already answered for: the project resources at the base
   * commit are the project's own (`trustDigest` equal, so it inherits the project's answer, which must be "trusted" when there are any), or there are none. The draft skill is
   * written after this check and is the one resource that makes the worktree differ from the project. Returns why not, as a sentence, or `undefined` when the worktree is trusted now.
   */
  async trustScratch(scratch: string, project: string): Promise<string | undefined> {
    const pi = await loadPi();
    if (pi.hasTrustRequiringProjectResources(scratch)) {
      if (!(await this.sameResources(project, scratch))) return 'The project’s pi resources (extensions, skills, prompts, MCP servers) at the base commit differ from the ones in the project now, so the replay would run code nobody has looked at. Check out the base commit yourself and trust it there, or verify by hand.';
      if (!(await this.folderTrusted(project))) return 'The project has pi resources that are not trusted yet. Trust the project (Settings › Advanced) first: the replay would load the same ones.';
    }
    this.session.set(scratch, true);
    return undefined;
  }

  /** The scratch worktree is gone: forget its answer. */
  forgetScratch(scratch: string): void {
    this.session.delete(scratch);
  }

  async state(cwd: string): Promise<TrustState> {
    const pi = await loadPi();
    const resources = scanTrustResources(cwd, join(homedir(), '.agents', 'skills'));
    const hasResources = pi.hasTrustRequiringProjectResources(cwd);
    const base = { cwd, hasResources, resources };
    if (!hasResources) return { ...base, status: 'trusted', source: 'none' };
    const answer = await this.decision(cwd, undefined);
    return { ...base, status: answer.trusted === undefined ? 'ask' : answer.trusted ? 'trusted' : 'untrusted', source: answer.source };
  }

  /**
   * The answer `DefaultResourceLoader.reload({ resolveProjectTrust })` needs when a session opens: trust or not, no
   * dialog. `ask` counts as not trusted (the renderer has not asked yet, or the user has not answered).
   */
  async resolveForOpen(cwd: string, extensionsResult: LoadExtensionsResult): Promise<boolean> {
    const pi = await loadPi();
    if (!pi.hasTrustRequiringProjectResources(cwd)) return true;
    const answer = await this.decision(cwd, extensionsResult);
    return answer.trusted === true;
  }

  /**
   * Whether the folder has been *answered* trusted, whether or not it has anything to trust yet. A folder with no project resources is trusted for nothing (`state()` says `trusted`
   * because there is no question to ask); the moment something writes a `.pi/mcp.json` into it, it has resources and pi asks. A connector written "project only" would otherwise land in a file
   * pi then refuses to read, so it waits for this answer.
   */
  async folderTrusted(cwd: string): Promise<boolean> {
    return (await this.decision(cwd, undefined)).trusted === true;
  }

  async decide(cwd: string, decision: TrustDecision): Promise<TrustState> {
    const pi = await loadPi();
    const store = new pi.ProjectTrustStore(pi.getAgentDir());
    switch (decision) {
      case 'skip':
        this.session.set(cwd, false);
        break;
      case 'once':
        this.session.set(cwd, true);
        break;
      case 'remember':
        store.set(cwd, true);
        this.session.delete(cwd);
        break;
      case 'never':
        store.set(cwd, false);
        this.session.delete(cwd);
        break;
    }
    this.logger.log(`Project trust for ${cwd}: ${decision}`);
    return this.state(cwd);
  }

  /**
   * Every decision saved in pi's `trust.json` (Settings › Advanced). pi's `ProjectTrustStore` can read one folder but cannot list, so the file
   * is read here (it is `{ "<folder>": true | false | null }`, `null` meaning forgotten); `known` marks the folders pi-kit has opened.
   */
  async list(knownFolders: readonly string[]): Promise<TrustList> {
    const pi = await loadPi();
    const file = join(pi.getAgentDir(), 'trust.json');
    let data: Record<string, unknown> = {};
    try {
      if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const known = new Set(knownFolders);
    const entries = Object.entries(data)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
      .map(([path, decision]) => ({ path, decision, known: known.has(path), exists: existsSync(path) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { file, entries };
  }

  /** Forgets the saved answer for a folder: the next time pi asks again (or applies `defaultProjectTrust`). */
  async revoke(path: string): Promise<void> {
    const pi = await loadPi();
    new pi.ProjectTrustStore(pi.getAgentDir()).set(path, null);
    this.session.delete(path);
    this.logger.log(`Project trust for ${path}: revoked`);
  }

  /** The saved decision of pi's `trust.json` for the folder (or the closest parent), for `/trust`. */
  async saved(cwd: string): Promise<boolean | null> {
    const pi = await loadPi();
    return new pi.ProjectTrustStore(pi.getAgentDir()).get(cwd);
  }

  private async decision(folder: string, extensionsResult: LoadExtensionsResult | undefined): Promise<{ trusted: boolean | undefined; source: TrustSource }> {
    const cwd = await this.canonical(folder);
    if (overrideTrusts(cwd)) {
      this.logger.warn(`PI_KIT_TRUSTED_CWDS marks ${cwd} trusted (test flag).`);
      return { trusted: true, source: 'override' };
    }
    const once = this.session.get(cwd);
    if (once !== undefined) return { trusted: once, source: 'session' };
    const pi = await loadPi();
    const store = new pi.ProjectTrustStore(pi.getAgentDir());
    const fromExtension = extensionsResult ? await this.askExtensions(pi, cwd, extensionsResult) : await this.probe(pi, cwd);
    if (fromExtension.trusted !== 'undecided') {
      const trusted = fromExtension.trusted === 'yes';
      if (fromExtension.remember) store.set(cwd, trusted);
      return { trusted, source: 'extension' };
    }
    const saved = store.get(cwd);
    if (saved !== null) return { trusted: saved, source: 'saved' };
    const fallback = pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: false }).getDefaultProjectTrust();
    if (fallback === 'always') return { trusted: true, source: 'default' };
    if (fallback === 'never') return { trusted: false, source: 'default' };
    return { trusted: undefined, source: 'none' };
  }

  /** Loads the user-level extensions once to see whether one of them decides (`project_trust`). */
  private probe(pi: Awaited<ReturnType<typeof loadPi>>, cwd: string): Promise<{ trusted: Trusted; remember: boolean }> {
    let pending = this.probed.get(cwd);
    if (!pending) {
      pending = (async () => {
        try {
          const agentDir = pi.getAgentDir();
          const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
          const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager });
          return await this.askExtensions(pi, cwd, await loader.loadProjectTrustExtensions());
        } catch (error) {
          this.logger.warn(`Could not ask the extensions about project trust: ${error instanceof Error ? error.message : String(error)}`);
          return { trusted: 'undecided' as const, remember: false };
        }
      })();
      this.probed.set(cwd, pending);
    }
    return pending;
  }

  /** pi's `emitProjectTrustEvent`: the first `project_trust` handler that says yes or no owns the decision. */
  private async askExtensions(
    _pi: Awaited<ReturnType<typeof loadPi>>,
    cwd: string,
    result: LoadExtensionsResult,
  ): Promise<{ trusted: Trusted; remember: boolean }> {
    // There is no one to ask while a session opens: select / confirm / input answer "nothing" like pi's print mode.
    const ctx: ProjectTrustContext = {
      cwd,
      mode: 'rpc',
      hasUI: false,
      ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => undefined },
    };
    for (const extension of result.extensions) {
      for (const handler of extension.handlers.get('project_trust') ?? []) {
        try {
          const answer = (await (handler as (event: unknown, ctx: ProjectTrustContext) => Promise<{ trusted: Trusted; remember?: boolean }>)({ type: 'project_trust', cwd }, ctx)) ?? { trusted: 'undecided' };
          if (answer.trusted !== 'undecided') return { trusted: answer.trusted, remember: answer.remember === true };
        } catch (error) {
          this.logger.warn(`Extension ${extension.path} failed in project_trust: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { trusted: 'undecided', remember: false };
  }
}
