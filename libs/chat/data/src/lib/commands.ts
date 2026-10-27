import { Language } from '@pi-kit/i18n';
import { Injectable, inject } from '@angular/core';
import {
  ApiClient,
  sessionChangelog,
  sessionCompact,
  sessionExport,
  sessionModels,
  sessionReload,
  sessionStats,
  sessionUsage,
  settingsImportSession,
  unwrap,
} from '@pi-kit/api';
import { commandGroups } from '@pi-kit/chat/util';
import { DialogStore, type SettingsTab, UiStore } from '@pi-kit/data-access';
import type { PkMenuGroup, PkMenuItem } from '@pi-kit/design-system';
import { type Command, THINKING_LEVELS, type ThinkingLevel } from '@pi-kit/protocol';
import { AttendantStore, NewThreadStore, ThreadsStore, TrustStore, WorktreeStore } from '@pi-kit/threads/api';
import { ChatStore, errorText } from './chat.store';

/**
 * The dispatcher of the one command registry on the client. The list (`GET /api/threads/:id/commands`: pi's discovered
 * commands plus the built-ins) lives in `ChatStore`, which also builds the `/` menu from it; this runs the built-ins (`kind:
 * "action"`) by mapping each to a REST endpoint, a panel or the threads store. Prompt commands (`kind: "prompt"`) are not run here:
 * the composer sends their text through AG-UI and pi expands or executes it.
 */
@Injectable({ providedIn: 'root' })
export class CommandRegistry {
  protected readonly i18n = inject(Language);
  private readonly api = inject(ApiClient);
  private readonly threads = inject(ThreadsStore);
  private readonly chat = inject(ChatStore);
  private readonly dialogs = inject(DialogStore);
  private readonly bus = inject(UiStore);
  private readonly trust = inject(TrustStore);
  private readonly attendant = inject(AttendantStore);
  private readonly worktrees = inject(WorktreeStore);
  private readonly newThreads = inject(NewThreadStore);

  find(name: string): Command | undefined {
    return this.chat.findCommand(name);
  }

  /** The commands as menu groups (the ⌘K palette's list), in the fixed group order, best match first inside each group. */
  groups(query: string): PkMenuGroup[] {
    return commandGroups(this.i18n.t, this.chat.commands(), query);
  }

  /** The flat, selectable order of `groups()` (disabled entries are shown but skipped by the keyboard). */
  flat(groups: PkMenuGroup[]): PkMenuItem[] {
    return groups.flatMap((g) => g.items).filter((i) => !i.disabled);
  }

  // ---- dispatch of the built-ins

  /** Runs a built-in (`kind: "action"`). `args` is the text after the command name. */
  async run(command: Command, args = ''): Promise<void> {
    const id = this.threads.selectedId();
    const arg = args.trim();
    const chat = this.chat;
    try {
      switch (command.name) {
        case 'new':
          return await this.newThread(arg === 'worktree' ? 'worktree' : undefined);
        case 'worktree':
          return await this.worktreeCommand(arg);
        case 'resume':
          return this.bus.focusThreadSearch();
        case 'hotkeys':
          return this.dialogs.show({ kind: 'hotkeys' });
        case 'tree':
          return void this.bus.setPanel('tree');
        case 'mcp':
          return this.bus.openMcpPanel();
        case 'connect':
          return this.bus.openMcpPanel();
        case 'settings':
          // `/settings <section>` opens that section (`/settings computer-use`, the computer-use package's suggestion); an unknown name opens General.
          return this.bus.openSettings((arg || undefined) as SettingsTab | undefined);
        case 'llama':
          return this.bus.openSettings('local-models');
        case 'project':
          return this.bus.openProjectMenu();
        case 'attendant':
          return await this.attendantCommand(arg);
        case 'scoped-models':
          return this.bus.openSettings('models');
        case 'setup':
          return this.bus.openOnboarding();
        case 'login':
          return this.bus.openSettings('providers', arg || undefined);
        case 'logout':
          return this.bus.openSettings('providers');
        case 'trust': {
          const cwd = this.threads.selected()?.cwd ?? this.threads.workspace();
          if (!cwd) return chat.say('info', this.i18n.t('chat.commands.openAFolderFirst'));
          await this.trust.review(cwd);
          // A new answer reopens the folder's sessions; the command list and the meter follow.
          await chat.loadCommands();
          return void (await chat.refreshStats());
        }
        case 'import': {
          const cwd = this.threads.workspace();
          if (!cwd) return chat.say('info', this.i18n.t('chat.commands.openAFolderFirst'));
          const path =
            arg ||
            (await this.dialogs.askName('', this.i18n.t('chat.commands.importASession'), '/path/to/session.jsonl'));
          if (!path) return;
          const thread = await unwrap(settingsImportSession({ client: this.api.client, body: { path, cwd } }));
          await this.threads.refresh();
          this.threads.select(thread.id);
          return;
        }
        case 'quit':
          return window.piKit?.quit ? void window.piKit.quit() : window.close();
        case 'changelog': {
          const log = await unwrap(sessionChangelog({ client: this.api.client }));
          return this.dialogs.show({ kind: 'changelog', version: log.version, text: log.text });
        }
      }
      if (!id) return chat.say('info', this.i18n.t('chat.commands.openAThreadFirst'));
      switch (command.name) {
        case 'model':
        case 'thinking':
          return await this.model(id, command.name, arg);
        case 'fork':
        case 'clone': {
          const created = command.name === 'fork' ? await this.threads.fork(id) : await this.threads.clone(id);
          this.threads.select(created.id);
          return chat.say(
            'info',
            command.name === 'fork'
              ? this.i18n.t('chat.commands.forkedIntoANewThread')
              : this.i18n.t('chat.commands.clonedIntoANewThread'),
          );
        }
        case 'compact': {
          chat.say('info', this.i18n.t('chat.commands.compactingTheContext'));
          const result = await unwrap(
            sessionCompact({
              client: this.api.client,
              path: { id },
              body: arg || undefined ? { instructions: arg || undefined } : {},
            }),
          );
          chat.reconnect();
          return chat.say(
            'info',
            this.i18n.t('chat.commands.contextCompactedWasTokens', { value1: result.tokensBefore.toLocaleString() }),
          );
        }
        case 'name': {
          const current = this.threads.selected()?.title ?? '';
          const name = arg || (await this.dialogs.askName(current));
          if (name) await this.threads.rename(id, name);
          return;
        }
        case 'session':
          return this.dialogs.show({
            kind: 'session',
            stats: await unwrap(sessionStats({ client: this.api.client, signal: undefined, path: { id } })),
          });
        case 'cost':
          return await this.showUsage();
        case 'reload': {
          const result = await unwrap(sessionReload({ client: this.api.client, path: { id } }));
          await chat.loadCommands(id);
          return chat.say('info', this.i18n.t('chat.commands.reloadedCommandsAvailable', { value1: result.commands }));
        }
        case 'export': {
          const result = await unwrap(
            sessionExport({
              client: this.api.client,
              path: { id },
              body: arg || undefined ? { path: arg || undefined } : {},
            }),
          );
          return chat.say('info', this.i18n.t('chat.commands.exportedTheSessionTo', { value1: result.path }));
        }
        case 'copy': {
          const text = chat.lastAssistantText();
          if (!text) return chat.say('info', this.i18n.t('chat.commands.thereIsNoAssistantMessageToCopy'));
          await navigator.clipboard.writeText(text);
          return chat.say('info', this.i18n.t('chat.commands.copiedTheLastAssistantMessage'));
        }
        default:
          return chat.say('warning', `/${command.name} is not available yet.`);
      }
    } catch (error) {
      chat.say('error', `/${command.name}: ${errorText(error)}`);
    }
  }

  /** `/cost`, the context meter and the status bar's totals: usage by model and by turn from the session file. */
  async showUsage(): Promise<void> {
    const id = this.threads.selectedId();
    if (!id) return this.chat.say('info', this.i18n.t('chat.commands.openAThreadFirst'));
    try {
      this.dialogs.show({
        kind: 'usage',
        usage: await unwrap(sessionUsage({ client: this.api.client, path: { id } })),
      });
    } catch (error) {
      this.chat.say('error', this.i18n.t('chat.commands.usage', { value1: errorText(error) }));
    }
  }

  /**
   * A new thread (⌘N, ⌘⇧N, `/new`): its page opens with the Where row, which starts from the project's defaults or, with `mode`, shows Local or Worktree.
   * Nothing is made in git until the first message is sent.
   */
  async newThread(mode?: 'local' | 'worktree'): Promise<void> {
    const thread = await this.threads.create();
    if (thread) {
      if (mode) await this.newThreads.preset(thread, mode);
      this.threads.select(thread.id);
      this.bus.focusComposer();
    }
  }

  /** `/worktree new`: a thread in its own git worktree at once, with the project's defaults. */
  private async newWorktreeNow(): Promise<void> {
    const thread = await this.threads.create(undefined, {});
    if (thread) {
      this.threads.select(thread.id);
      this.bus.focusComposer();
    }
  }

  /** `/worktree new` starts a thread in a worktree; `sync` and `merge` open the thread's Sync with base and Merge back dialogs. */
  private async worktreeCommand(arg: string): Promise<void> {
    const word = arg.split(/\s+/)[0];
    if (word === 'new') return this.newWorktreeNow();
    const thread = this.threads.selected();
    if (word === 'sync' || word === 'merge') {
      if (!thread?.worktree?.exists) return this.chat.say('info', this.i18n.t('chat.commands.thisThreadDoesNotRunInA'));
      return void (await this.worktrees.openDialog(thread.id, word));
    }
    return this.chat.say('info', this.i18n.t('chat.commands.useWorktreeNewForAThreadIn'));
  }

  /** `/attendant`: for the current project on or off (no argument toggles); `activity` opens what the attendant did. */
  private async attendantCommand(arg: string): Promise<void> {
    if (arg === 'activity') return this.bus.openSettings('attendant');
    const cwd = this.threads.selected()?.cwd ?? this.threads.workspace();
    if (!cwd) return this.chat.say('info', this.i18n.t('chat.commands.openAProjectFirst'));
    const name = this.threads.workspaces().find((w) => w.cwd === cwd)?.name ?? this.i18n.t('chat.commands.thisProject');
    const now = this.threads.workspaces().find((w) => w.cwd === cwd)?.attendant ?? true;
    const want = arg === 'on' ? true : arg === 'off' ? false : !now;
    if (want !== now) await this.threads.setAttendant(cwd, want);
    const status = await this.attendant.load().then(() => this.attendant.enabled());
    this.chat.say(
      'info',
      this.i18n.t('chat.commands.theAttendantIsFor', {
        value1: want ? this.i18n.t('chat.commands.allowed') : this.i18n.t('chat.commands.turnedOff'),
        value2: name,
        value3: want && !status ? this.i18n.t('chat.commands.itIsOffInSettingsAttendant') : '',
      }),
    );
  }

  private async model(id: string, name: 'model' | 'thinking', arg: string): Promise<void> {
    // Without an argument the composer's model picker opens: at the search field for /model, at the Effort row for /thinking.
    if (!arg) return this.bus.openChipMenu(name === 'model' ? 'model' : 'effort');
    if (name === 'thinking') {
      if (!(THINKING_LEVELS as readonly string[]).includes(arg)) {
        return this.chat.say(
          'warning',
          this.i18n.t('chat.commands.unknownThinkingLevelUse', { value1: arg, value2: THINKING_LEVELS.join(', ') }),
        );
      }
      await this.chat.setEffort(arg as ThinkingLevel);
      return;
    }
    const list = await unwrap(sessionModels({ client: this.api.client, signal: undefined, query: { thread: id } }));
    const [provider, ...rest] = arg.split('/');
    const wanted = rest.length > 0 ? { provider, id: rest.join('/') } : undefined;
    const match = list.models.find((m) =>
      wanted ? m.provider === wanted.provider && m.id === wanted.id : m.id === arg,
    );
    if (!match)
      return this.chat.say('warning', this.i18n.t('chat.commands.noAvailableModelPickOneFromThe', { value1: arg }));
    await this.chat.chooseModel(match);
  }
}
