import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  NgZone,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { groupProviders } from '@pi-kit/protocol';
import { PkIcon, PkItem, PkQuota, PkTip } from '@pi-kit/design-system';
import { LoginFlow, ProviderCardsStore, SecretsStore, SettingsStore } from '@pi-kit/settings/api';
import {
  type ProviderRow,
  addProvider,
  environmentRows,
  letters,
  modelCountText,
  providerRows,
} from '@pi-kit/settings/util';
import { ProviderUsageStore, ToastStore } from '@pi-kit/data-access';
import { AddProviderWizard } from './add-provider-wizard';

/** Explicit bundled brand marks. Never construct an asset URL from a user-defined provider ID. */
const providerMarks = new Map<string, string>([
  ['anthropic', 'anthropic'],
  ['openrouter', 'openrouter'],
  ['ollama', 'ollama'],
  ['llama.cpp', 'llama-cpp'],
  ['llama-swap', 'llama-cpp'],
  ['deepseek', 'deepseek'],
  ['zai', 'zai'],
  ['z-ai', 'zai'],
  ['zai-coding-plan', 'zai'],
  ['openai', 'openai'],
  ['openai-codex', 'openai'],
  ['mistral', 'mistral'],
  ['groq', 'groq'],
  ['github-copilot', 'githubcopilot'],
  ['google', 'google'],
  ['google-gemini-cli', 'google'],
  ['google-antigravity', 'google'],
  ['cohere', 'cohere'],
  ['perplexity', 'perplexity'],
  ['xai', 'xai'],
  ['qwen', 'qwen'],
  ['kimi', 'kimi'],
  ['moonshotai', 'kimi'],
  ['cerebras', 'cerebras'],
  ['minimax', 'minimax'],
]);

/**
 * Settings › Providers: the page shows what is signed in, as `pk-item` rows with the state chip
 * (subscription, API key, local), the model count, the credential line (“key ending in a1b2 · macOS Keychain · added today”, never the key) and icon actions with tooltips. A
 * second, read-only group lists keys pi found in the environment, with “Add a key instead”. Adding is the amber “+” in the group header, which opens the wizard
 * (`pk-add-provider-wizard`, a lazy chunk); nothing of it lives on the page. Usage bars appear when the provider reports usage (`ProviderInfo.usage`).
 */
@Component({
  selector: 'pk-providers-section',
  imports: [
    AddProviderWizard,
    LoginFlow,
    PkItem,
    PkQuota,
    PkTip,
    NgTemplateOutlet,
    TranslocoPipe,
    CdkTrapFocus,
    PkIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:focus)': 'refreshUsage()' },
  styleUrl: './providers-section.css',
  templateUrl: './providers-section.html',
})
export class ProvidersSection {
  protected readonly i18n = inject(Language);
  readonly usageRefreshMs = input(60_000);
  protected readonly store = inject(SettingsStore);
  protected readonly secrets = inject(SecretsStore);
  private readonly cards = inject(ProviderCardsStore);
  private readonly toasts = inject(ToastStore);
  private readonly usage = inject(ProviderUsageStore);
  private readonly zone = inject(NgZone);

  protected readonly removing = signal<ProviderRow | undefined>(undefined);
  protected readonly removeBusy = signal(false);

  protected closeRemoval(): void {
    if (!this.removeBusy()) this.removing.set(undefined);
  }

  protected async removeProvider(): Promise<void> {
    const row = this.removing();
    if (!row || this.removeBusy()) return;
    this.removeBusy.set(true);
    try {
      if (await this.store.removeProvider(row.id)) this.removing.set(undefined);
    } finally {
      this.removeBusy.set(false);
    }
  }

  /** The wizard is open when this holds where it starts. */
  protected readonly wizard = signal<{ method?: addProvider.ProviderMethod; provider?: string } | undefined>(undefined);

  /** The address of each local server that was detected, by the provider name `saveLocal` gives it. */
  private readonly addresses = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const server of this.cards.servers())
      out[server.kind === 'ollama' ? 'ollama' : server.kind === 'llama-swap' ? 'llama-swap' : 'local'] = server.baseUrl;
    return out;
  });
  private readonly configuredProviders = computed(() => this.store.overview()?.providers ?? []);
  private readonly usageIds = computed(() =>
    this.configuredProviders()
      .filter((p) => p.configured && p.methods.length > 0)
      .map((p) => p.id),
  );
  private readonly providers = computed(() => this.usage.withUsage(this.configuredProviders()));
  private readonly models = computed(() => this.store.overview()?.models ?? []);
  protected readonly rows = computed(() =>
    providerRows(this.i18n.t, this.providers(), this.models(), this.secrets.status()?.label, this.addresses()),
  );
  protected readonly groups = computed(() =>
    groupProviders(this.rows()).map((group) => ({
      ...group,
      models: group.connections.reduce((count, connection) => count + connection.models, 0),
    })),
  );
  protected readonly environment = computed(() =>
    environmentRows(this.i18n.t, this.providers(), this.models(), this.secrets.status()?.label),
  );
  /** The storage chip's tip is the file it names. */
  protected readonly authTip = computed(
    () =>
      `${this.store.settings()?.agentDir ?? '~/.pi/agent'}/auth.json, readable by you only; the pi command line sees the same credentials.`,
  );
  protected readonly summary = computed(() => {
    const n = this.groups().length;
    return n === 0
      ? this.i18n.t('settings.providersSection.nothingIsSignedInYet')
      : this.i18n.t('settings.providersSection.eachShowsHowItIsSignedIn', {
          value1: n,
          value2:
            n === 1
              ? this.i18n.t('settings.providersSection.provider')
              : this.i18n.t('settings.providersSection.providerNounPlural'),
          value3: this.rows().some((r) => r.usage)
            ? this.i18n.t('settings.providersSection.andHowMuchOfItsWindowIs')
            : '',
        });
  });

  constructor() {
    void this.secrets.loadStatus();
    void this.cards.detect();
    effect((onCleanup) => {
      const ids = this.usageIds();
      const interval = this.usageRefreshMs();
      untracked(() => void this.usage.refresh(ids));
      const timer = this.zone.runOutsideAngular(() => setInterval(() => void this.usage.refresh(ids, true), interval));
      onCleanup(() => clearInterval(timer));
    });
  }

  /** Returning from adding funds must bypass both usage caches. */
  protected refreshUsage(): void {
    void this.usage.refresh(this.usageIds(), true);
  }

  protected open(entry: { method?: addProvider.ProviderMethod; provider?: string } = {}): void {
    this.wizard.set(entry);
  }

  /** Model-specific local routes may use a recognized model-family mark; custom names keep initials. */
  protected logo(row: ProviderRow): string | undefined {
    let mark = providerMarks.get(row.id.toLowerCase());
    if (!mark && row.kind === 'local' && /\((?:llama-swap|llama\.cpp)\)$/i.test(row.name)) {
      const family = /^(deepseek|glm|z\.ai|qwen|kimi|minimax|mistral)(?=$|[\s./-])/i.exec(row.name)?.[1].toLowerCase();
      mark = family ? providerMarks.get(family === 'glm' || family === 'z.ai' ? 'zai' : family) : undefined;
    }
    return mark ? `/provider-logos/${mark}.svg` : undefined;
  }

  protected readonly letters = letters;

  protected connectionName(row: ProviderRow): string {
    return row.name.replace(/\s*\((llama-swap|llama\.cpp)\)$/i, '');
  }

  protected connectionSource(row: ProviderRow): string {
    const match = row.name.match(/\((llama-swap|llama\.cpp)\)$/i);
    return match?.[1] ?? '';
  }

  protected count(row: ProviderRow): string {
    return modelCountText(row.models);
  }

  /** “Test the connection” on a local server: look at the machine again and say whether it answers. */
  protected async test(row: ProviderRow): Promise<void> {
    await this.cards.detect();
    const address = this.addresses()[row.id];
    if (address)
      this.toasts.show(
        'success',
        this.i18n.t('settings.providersSection.answersAt', { value1: row.name, value2: address }),
      );
    else
      this.toasts.show(
        'warning',
        this.i18n.t('settings.providersSection.didNotAnswerIsTheServerRunning', { value1: row.name }),
      );
  }

  protected names(ids: readonly string[]): string {
    return ids.map((id) => this.providers().find((p) => p.id === id)?.name ?? id).join(', ');
  }
}
