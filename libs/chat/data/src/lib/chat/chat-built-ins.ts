import type { Translate } from '@pi-kit/i18n';
import { patchState } from '@ngrx/signals';
import { composerComplete, sessionWorkspaceFiles, unwrap } from '@pi-kit/api';
import { chipOfCommand, commandGroups, fileRefsOf, parseSlash, withoutSlashToken } from '@pi-kit/chat/util';
import type { PkMenuItem } from '@pi-kit/design-system';
import { type Command, type FileMatch } from '@pi-kit/protocol';
import { CommandRegistry } from '../commands';
import { type CompletionItem, type CompletionProvider, type CompletionToken } from '../composer-extensions';
import { ChatConnectors, ChatTree } from '../ports';
import type { BuiltInContext } from './chat-action-context';
import type { createChatComposerActions } from './chat-composer-actions';
import { type Notice, errorText } from './chat-state';
type Composer = ReturnType<typeof createChatComposerActions>;
interface BuiltInActions extends Pick<Composer, 'insertAt' | 'clearDraft' | 'addChip' | 'setDraft'> {
  runShell: (threadId: string, command: string, exclude: boolean) => Promise<void>;
  say: (level: Notice['level'], text: string) => void;
}
export function registerChatBuiltIns(translate: Translate, store: BuiltInContext, actions: BuiltInActions): void {
  const { insertAt, clearDraft, addChip, setDraft, runShell, say } = actions;
  const api = store._api;
  const bus = store._bus;
  const registry = () => store._injector.get(CommandRegistry);
  const tree = () => store._injector.get(ChatTree);
  function registerBuiltIns(): void {
    const ext = store._extensions;
    const threads = store._threads;

    ext.addAction({
      id: 'at',
      label: translate('chat.chatBuiltIns.referenceAFile'),
      icon: '@',
      mono: true,
      order: 10,
      source: 'app',
      run: () => insertAt('@'),
    });
    ext.addAction({
      id: 'shell',
      label: translate('chat.chatBuiltIns.runAShellCommand'),
      icon: '!',
      mono: true,
      order: 20,
      source: 'app',
      run: () =>
        patchState(store, (s) => ({ draft: s.draft.startsWith('!') ? s.draft.replace(/^!+\s?/, '') : `!${s.draft}` })),
    });

    ext.addTransform({
      id: 'shell',
      order: 10,
      transform: async (input) => {
        if (!input.text.startsWith('!')) return input;
        const threadId = store.threadId();
        const command = input.text.replace(/^!+\s*/, '');
        if (!threadId || !command) return { ...input, handled: true };
        clearDraft();
        void runShell(threadId, command, input.text.startsWith('!!'));
        return { ...input, handled: true };
      },
    });
    ext.addTransform({
      id: 'command',
      order: 20,
      transform: async (input) => {
        const slash = parseSlash(input.text);
        const command = slash ? store.commands().find((c) => c.name === slash.name) : undefined;
        if (!slash || command?.kind !== 'action') return input;
        if (command.disabled) {
          say('info', command.disabledReason ?? `/${command.name} is not available.`);
          return { ...input, handled: true };
        }
        clearDraft();
        void registry().run(command, slash.args);
        return { ...input, handled: true };
      },
    });
    ext.addTransform({
      id: 'branch',
      order: 30,
      // "Edit and branch": the leaf moves to the edited turn's parent first, then the prompt is its sibling. The text stays in
      // the composer until that worked.
      transform: async (input) => {
        if (!tree().branch()) return input;
        try {
          await tree().commitBranch();
        } catch (error) {
          return { ...input, refuse: translate('chat.chatBuiltIns.branching', { value1: errorText(error) }) };
        }
        return input;
      },
    });
    ext.addTransform({
      id: 'file-refs',
      order: 40,
      transform: async (input) => ({ ...input, fileRefs: fileRefsOf(input.text) }),
    });

    /** A skill or prompt template picked from a menu becomes a chip, and the `/query` that found it leaves the text. */
    const chipItem = (
      item: PkMenuItem,
      command: Command | undefined,
      token: CompletionToken,
    ): CompletionItem | undefined => {
      const chip = command && chipOfCommand(command);
      if (!chip) return undefined;
      const present = store.chips().some((c) => c.kind === chip.kind && c.name === chip.name);
      return {
        ...item,
        ...(present ? { disabled: true, title: translate('chat.chatBuiltIns.alreadyOnThisMessage') } : {}),
        apply: () => ({
          run: () => {
            const rest = withoutSlashToken(store.draft(), token.start, store.caret());
            addChip(chip);
            setDraft(rest.text, rest.caret);
            bus.focusComposer();
          },
        }),
      };
    };

    const slash: CompletionProvider = {
      id: 'slash',
      title: translate('chat.chatBuiltIns.commands'),
      order: 10,
      showEmpty: true,
      match(text, caret) {
        const found = /^\/(\S*)$/.exec(text.slice(0, caret));
        return found && !/^\S/.test(text.slice(caret)) ? { start: 0, query: found[1] } : undefined;
      },
      complete(token) {
        const byName = new Map(store.commands().map((c) => [c.name, c]));
        const commands = commandGroups(translate, store.commands(), token.query).flatMap((group) =>
          group.items.map((item): CompletionItem => {
            const command = byName.get(item.id);
            // Skills and prompt templates are chips.
            const asChip = chipItem(item, command, token);
            if (asChip) return { ...asChip, group: group.title };
            return {
              ...item,
              group: group.title,
              apply() {
                // A built-in that takes no argument runs on the spot; anything else waits for its arguments.
                if (command?.kind === 'action' && !command.argumentHint && !command.disabled) {
                  return {
                    run: () => {
                      patchState(store, { draft: '', caret: 0 });
                      void registry().run(command);
                    },
                  };
                }
                const next = `/${item.id} `;
                return { text: next, caret: next.length };
              },
            };
          }),
        );
        // A connected connector whose tools are declared to the model is a group of its own: "Linear: create issue, search issues…".
        const query = token.query.trim().toLowerCase();
        const connectors = store._injector
          .get(ChatConnectors)
          .menuGroups()
          .filter(
            (g) =>
              !query ||
              g.title.toLowerCase().includes(query) ||
              g.server.toLowerCase().includes(query) ||
              'connect'.startsWith(query),
          )
          .map((g): CompletionItem => ({
            id: `connector:${g.server}`,
            name: g.line,
            badge: 'connector',
            badgeClass: 'badge-outline',
            group: 'Connectors',
            apply: () => ({ text: g.insert, caret: g.insert.length }),
          }));
        // Few and close to what the person is about to ask for: they come before the long list of skills.
        return [...connectors, ...commands];
      },
    };
    // A `/` after other words (a word of its own, not a path) offers the skills and prompt templates only: they are chips, so they can be anywhere in the text.
    const chipSlash: CompletionProvider = {
      id: 'chip-slash',
      title: translate('chat.chatBuiltIns.skillsAndTemplates'),
      order: 15,
      match(text, caret) {
        const before = text.slice(0, caret);
        const found = /\s\/([^\s/]*)$/.exec(before);
        return found && !/^\S/.test(text.slice(caret)) ? { start: found.index + 1, query: found[1] } : undefined;
      },
      complete(token) {
        const byName = new Map(store.commands().map((c) => [c.name, c]));
        const pickable = store.commands().filter((c) => (c.source === 'skill' || c.source === 'prompt') && !c.disabled);
        return commandGroups(translate, pickable, token.query).flatMap((group) =>
          group.items.flatMap((item): CompletionItem[] => {
            const made = chipItem(item, byName.get(item.id), token);
            return made ? [{ ...made, group: group.title }] : [];
          }),
        );
      },
    };
    const files: CompletionProvider = {
      id: 'file',
      title: translate('chat.chatBuiltIns.files'),
      order: 20,
      debounceMs: 80,
      match(text, caret) {
        const before = text.slice(0, caret);
        const at = /(^|\s)@([^\s]*)$/.exec(before);
        return at ? { start: before.length - at[2].length - 1, query: at[2] } : undefined;
      },
      async complete(token, ctx) {
        const cwd = threads.folder();
        if (!cwd) return [];
        let matches: FileMatch[];
        try {
          matches = await unwrap(
            sessionWorkspaceFiles({
              client: api.client,
              path: { id: cwd },
              query: { q: token.query },
              signal: ctx.signal,
            }),
          );
        } catch {
          return [];
        }
        return matches.map((m): CompletionItem => ({
          id: m.path,
          name: m.path,
          badge: m.dir ? 'folder' : undefined,
          badgeClass: 'badge-ghost',
          apply() {
            const text = store.draft();
            const inserted = `@${m.path}${m.dir ? '' : ' '}`;
            return {
              text: text.slice(0, token.start) + inserted + text.slice(store.caret()),
              caret: token.start + inserted.length,
            };
          },
        }));
      },
    };
    // Argument completion from the pi extensions of the thread (`ctx.ui.addAutocompleteProvider`): the backend runs the chain.
    const args: CompletionProvider = {
      id: 'args',
      title: translate('chat.chatBuiltIns.suggestions'),
      order: 30,
      debounceMs: 120,
      match(text, caret) {
        const before = text.slice(0, caret);
        const found = /^\/(\S+)\s/.exec(before);
        if (!found || before.includes('\n')) return undefined;
        // Built-ins complete nowhere but in the app; the extensions' completers only know their own commands.
        if (!store.commands().some((c) => c.name === found[1] && c.source !== 'builtin')) return undefined;
        return { start: before.search(/\S*$/), query: before };
      },
      async complete(_token, ctx) {
        const threadId = store.threadId();
        if (!threadId) return [];
        try {
          const response = await unwrap(
            composerComplete({
              client: api.client,
              path: { id: threadId },
              body: { text: ctx.text, cursor: ctx.caret },
              signal: ctx.signal,
            }),
          );
          return response.items.map((item, i): CompletionItem => ({
            id: `${i}:${item.value}`,
            name: item.label,
            description: item.description,
            apply: () => ({ text: item.insert.text, caret: item.insert.cursor }),
          }));
        } catch {
          return [];
        }
      },
    };
    ext.addProvider(slash);
    ext.addProvider(chipSlash);
    ext.addProvider(files);
    ext.addProvider(args);
  }

  /** A `pi.composer` event: a toolbar action or a suggestion a pi extension registered (or removed). */

  registerBuiltIns();
}
