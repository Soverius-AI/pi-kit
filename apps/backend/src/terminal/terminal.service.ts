import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type { TerminalEvent, TerminalInfo } from '@pi-kit/protocol';
import { type IPty, spawn } from 'node-pty';
import { RedactionService } from '../db/redaction.service';
import { TerminalReplayRepository } from '../db/terminal-replay.repository';

/** What a late client gets replayed: the tail of the output, so a reload shows the screen as it was. */
export const SCROLLBACK_CHARS = 256 * 1024;

/** Variables that belong to pi-kit's own processes and must not leak into the user's shell. */
const HIDDEN_ENV = /^(PI_KIT_|npm_|pnpm_|PNPM_|ELECTRON_|NX_)|^(NODE_ENV|INIT_CWD)$/;

export function shellEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !HIDDEN_ENV.test(key)) out[key] = value;
  }
  // `pnpm run` (like `npm run`) puts the repository's `node_modules/.bin` in front of PATH (pnpm as a relative `./node_modules/.bin` too); the user's shell should not start with it.
  if (out['PATH']) out['PATH'] = out['PATH'].split(':').filter((dir) => !dir.endsWith('/node_modules/.bin')).join(':');
  out['TERM'] = 'xterm-256color';
  out['COLORTERM'] = 'truecolor';
  return out;
}

export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') return { file: env['COMSPEC'] ?? 'powershell.exe', args: [] };
  // A login shell, like a terminal window opens, so PATH and the user's profile are what they expect.
  return { file: env['SHELL'] || '/bin/sh', args: ['-l'] };
}

/**
 * node-pty's macOS prebuild ships `spawn-helper` without the execute bit when the package manager unpacks it from some caches, and
 * `spawn` then fails with `posix_spawnp failed`. Setting the bit is idempotent and harmless.
 */
export function ensureSpawnHelper(): void {
  const roots: string[] = [];
  try {
    roots.push(dirname(require.resolve('node-pty/package.json')));
  } catch {
    // The package cannot be resolved from here: fall back to the folders below.
  }
  // Where node-pty is when the backend runs from the repository (dev:web, e2e: cwd is the workspace) or from the packaged
  // app (cwd is resources/backend, which carries its own node_modules; see scripts/package-stage.mjs).
  roots.push(join(process.cwd(), 'node_modules', 'node-pty'));
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) roots.push(join(resources, 'backend', 'node_modules', 'node-pty'));
  for (const root of roots) {
    for (const dir of [join(root, 'prebuilds', `${process.platform}-${process.arch}`), join(root, 'build', 'Release')]) {
      const helper = join(dir, 'spawn-helper');
      try {
        if (existsSync(helper)) chmodSync(helper, 0o755);
      } catch {
        // Read-only location (a signed app bundle keeps its bits anyway); spawn will say what is wrong.
      }
    }
  }
}

/** How long output may sit unsaved before the last screen is written to the database. */
const REPLAY_SAVE_MS = 2000;

interface Terminal {
  pty: IPty;
  saveTimer?: ReturnType<typeof setTimeout>;
  info: Omit<TerminalInfo, 'created'>;
  scrollback: string;
  listeners: Set<(event: TerminalEvent) => void>;
}

/**
 * One convenience terminal per workspace: a login shell on a pseudo-terminal in the workspace folder,
 * kept while the backend runs, so closing the panel or reloading the window does not kill what runs in it. This is the
 * user's shell, not pi's `bash` tool: nothing here goes to the model or into a session.
 */
@Injectable()
export class TerminalService implements OnModuleDestroy {
  private readonly logger = new Logger(TerminalService.name);
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    /** The last screen of each terminal is kept here, redacted, so a restart of the backend shows it again; absent in tests that do not care. */
    @Optional() private readonly replay?: TerminalReplayRepository,
    @Optional() private readonly redaction?: RedactionService,
  ) {}

  /** The workspace's terminal, started if it has none. A running one is resized to the caller's size. */
  start(cwd: string, cols: number, rows: number): TerminalInfo {
    const existing = this.terminals.get(cwd);
    if (existing) {
      this.resize(cwd, cols, rows);
      return { ...existing.info, cols, rows, created: false };
    }
    ensureSpawnHelper();
    const { file, args } = defaultShell();
    const pty = spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: shellEnvironment() });
    const terminal: Terminal = { pty, info: { cwd, shell: file, pid: pty.pid, cols, rows }, scrollback: '', listeners: new Set() };
    this.terminals.set(cwd, terminal);
    // What the terminal of this folder last showed (before the backend restarted) comes first, marked as over.
    const previous = this.replay?.get(cwd);
    if (previous?.data) terminal.scrollback = `${previous.data}\r\n\x1b[2m--- end of the previous terminal session ---\x1b[0m\r\n`;
    pty.onData((data) => {
      terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_CHARS);
      this.emit(terminal, { type: 'data', data });
      this.scheduleSave(cwd, terminal);
    });
    pty.onExit(({ exitCode, signal }) => {
      this.logger.log(`Terminal in ${cwd} ended (${exitCode})`);
      this.saveNow(cwd, terminal);
      if (this.terminals.get(cwd) === terminal) this.terminals.delete(cwd);
      this.emit(terminal, { type: 'exit', exitCode, signal: signal ?? null });
      terminal.listeners.clear();
    });
    this.logger.log(`Terminal started in ${cwd}: ${file} (pid ${pty.pid})`);
    return { ...terminal.info, created: true };
  }

  /** Replays the scrollback, then every event; returns the unsubscribe function, or undefined if there is no terminal. */
  subscribe(cwd: string, listener: (event: TerminalEvent) => void): (() => void) | undefined {
    const terminal = this.terminals.get(cwd);
    if (!terminal) return undefined;
    // A client that connects late is shown the screen with key shapes masked, as it is kept; what streams live is the shell's own output.
    if (terminal.scrollback) listener({ type: 'data', data: this.redaction ? this.redaction.text(cwd, terminal.scrollback) : terminal.scrollback });
    terminal.listeners.add(listener);
    return () => terminal.listeners.delete(listener);
  }

  write(cwd: string, data: string): boolean {
    const terminal = this.terminals.get(cwd);
    terminal?.pty.write(data);
    return !!terminal;
  }

  resize(cwd: string, cols: number, rows: number): boolean {
    const terminal = this.terminals.get(cwd);
    if (!terminal) return false;
    if (terminal.info.cols !== cols || terminal.info.rows !== rows) {
      terminal.pty.resize(cols, rows);
      terminal.info.cols = cols;
      terminal.info.rows = rows;
    }
    return true;
  }

  kill(cwd: string): boolean {
    const terminal = this.terminals.get(cwd);
    terminal?.pty.kill();
    return !!terminal;
  }

  has(cwd: string): boolean {
    return this.terminals.has(cwd);
  }

  onModuleDestroy(): void {
    for (const [cwd, terminal] of this.terminals) {
      this.saveNow(cwd, terminal);
      terminal.pty.kill();
    }
    this.terminals.clear();
  }

  /** The screen is saved a moment after output stops, not on every chunk. */
  private scheduleSave(cwd: string, terminal: Terminal): void {
    if (!this.replay || terminal.saveTimer) return;
    terminal.saveTimer = setTimeout(() => this.saveNow(cwd, terminal), REPLAY_SAVE_MS);
    terminal.saveTimer.unref();
  }

  private saveNow(cwd: string, terminal: Terminal): void {
    if (terminal.saveTimer) clearTimeout(terminal.saveTimer);
    terminal.saveTimer = undefined;
    if (!this.replay) return;
    try {
      // Key shapes are masked before the screen is kept (a cut at the 256 KB edge may split one; the next write sees the whole).
      this.replay.set(cwd, this.redaction ? this.redaction.text(cwd, terminal.scrollback) : terminal.scrollback);
    } catch (error) {
      this.logger.warn(`Could not save the terminal's last screen: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emit(terminal: Terminal, event: TerminalEvent): void {
    for (const listener of terminal.listeners) {
      try {
        listener(event);
      } catch {
        // A listener that threw belongs to a closed connection.
      }
    }
  }
}
