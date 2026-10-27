import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { computed } from '@angular/core';
import { type ToolsMenuItem } from '@copilotkit/angular';
import { type SignalStoreFeatureType, signalStoreFeature, type, withComputed } from '@ngrx/signals';
import { chipOfCommand } from '@pi-kit/chat/util';
import { type Command } from '@pi-kit/protocol';
import { CommandRegistry } from '../commands';
import { withChatActions } from './with-chat-actions';

/** Builds the tools menu from the composer and command registry. */
export function withChatTools<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withChatActions>>(),
    withComputed((store) => {
      const translate = inject(Language).t;
      return {
        /** CopilotKit's tools menu (⊕): the composer's own entries, then the command registry by source. */
        toolsMenu: computed<(ToolsMenuItem | '-')[]>(() => {
          const open = (command: Command) => () => {
            if (command.disabled)
              return store.say('info', command.disabledReason ?? `/${command.name} is not available.`);
            // A skill or prompt template is a chip, not text.
            const chip = chipOfCommand(command);
            if (chip) {
              store.addChip(chip);
              store._bus.focusComposer();
              return;
            }
            if (command.kind === 'action' && !command.argumentHint) {
              void store._injector.get(CommandRegistry).run(command);
              return;
            }
            store.setDraft(`/${command.name} `, command.name.length + 2);
            store._bus.focusComposer();
          };
          const groups: { source: Command['source']; label: string }[] = [
            { source: 'skill', label: translate('chat.withChatTools.skills') },
            { source: 'prompt', label: translate('chat.withChatTools.promptTemplates') },
            { source: 'extension', label: translate('chat.withChatTools.extensions') },
            { source: 'builtin', label: translate('chat.withChatTools.builtIn') },
          ];
          const sub = groups.flatMap(({ source, label }): ToolsMenuItem[] => {
            const list = store.commands().filter((c) => c.source === source && !c.disabled);
            return list.length ? [{ label, items: list.map((c) => ({ label: `/${c.name}`, action: open(c) })) }] : [];
          });
          return [
            { label: translate('chat.withChatTools.attachAnImage'), action: () => store.requestImagePicker() },
            { label: translate('chat.withChatTools.referenceAFile'), action: () => store.insertAt('@') },
            { label: translate('chat.withChatTools.runAShellCommand'), action: () => store.toggleShell() },
            ...(sub.length ? (['-', ...sub] as (ToolsMenuItem | '-')[]) : []),
          ];
        }),
      };
    }),
  );
}
