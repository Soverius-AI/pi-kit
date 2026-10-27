import { inject, type Provider } from '@angular/core';
import { COPILOT_CHAT_LABELS, type CopilotChatLabels } from '@copilotkit/angular';
import { Language } from '@pi-kit/i18n';

/** Getters let CopilotKit’s OnPush views track the active language without recreating chat state. */
export const LOCALIZED_CHAT_LABELS: Provider = {
  provide: COPILOT_CHAT_LABELS,
  useFactory: (): CopilotChatLabels => {
    const language = inject(Language);
    return {
      get chatInputPlaceholder() {
        return language.t('chat.labels.chatInputPlaceholder');
      },
      get chatInputToolbarAddButtonLabel() {
        return language.t('chat.labels.chatInputToolbarAddButtonLabel');
      },
      get chatInputToolbarToolsButtonLabel() {
        return language.t('chat.labels.chatInputToolbarToolsButtonLabel');
      },
      get assistantMessageToolbarCopyMessageLabel() {
        return language.t('chat.labels.assistantMessageToolbarCopyMessageLabel');
      },
      get assistantMessageToolbarThumbsUpLabel() {
        return language.t('chat.labels.assistantMessageToolbarThumbsUpLabel');
      },
      get assistantMessageToolbarThumbsDownLabel() {
        return language.t('chat.labels.assistantMessageToolbarThumbsDownLabel');
      },
      get assistantMessageToolbarRegenerateLabel() {
        return language.t('chat.labels.assistantMessageToolbarRegenerateLabel');
      },
      get assistantMessageToolbarReadAloudLabel() {
        return language.t('chat.labels.assistantMessageToolbarReadAloudLabel');
      },
      get userMessageToolbarCopyMessageLabel() {
        return language.t('chat.labels.userMessageToolbarCopyMessageLabel');
      },
      get userMessageToolbarEditMessageLabel() {
        return language.t('chat.labels.userMessageToolbarEditMessageLabel');
      },
      get welcomeMessageText() {
        return language.t('chat.labels.welcomeMessageText');
      },
      get chatInputToolbarStartTranscribeButtonLabel() {
        return language.t('chat.labels.chatInputToolbarStartTranscribeButtonLabel');
      },
      get chatInputToolbarCancelTranscribeButtonLabel() {
        return language.t('chat.labels.chatInputToolbarCancelTranscribeButtonLabel');
      },
      get chatInputToolbarFinishTranscribeButtonLabel() {
        return language.t('chat.labels.chatInputToolbarFinishTranscribeButtonLabel');
      },
      get assistantMessageToolbarCopyCodeLabel() {
        return language.t('chat.labels.assistantMessageToolbarCopyCodeLabel');
      },
      get assistantMessageToolbarCopyCodeCopiedLabel() {
        return language.t('chat.labels.assistantMessageToolbarCopyCodeCopiedLabel');
      },
      get chatDisclaimerText() {
        return language.t('chat.labels.chatDisclaimerText');
      },
    };
  },
};
