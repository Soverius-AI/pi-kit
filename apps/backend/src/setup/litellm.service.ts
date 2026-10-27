import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { Injectable } from '@nestjs/common';
import type { LiteLlmConnect, LiteLlmConnection } from '@pi-kit/protocol';
import { agentDirOf } from '../pi/pi-resolution';
import { loadPi } from '../pi/load-pi';
import { SecretsService } from '../secrets/secrets.service';
import { discoverLiteLlm, liteLlmBaseUrl, liteLlmModelDetails } from './litellm';
import { saveLocalProvider } from './local-models';

/**
 * The `litellm` provider entry of pi's `models.json`: reads it, discovers the proxy's models with the typed or the
 * saved key, saves the connection (the key goes to `SecretsService`, the file gets its resolver), and refreshes the
 * catalog for the model picker, one probe per saved connection at a time.
 */
@Injectable()
export class LiteLlmService {
  private refreshing?: { version: string; request: Promise<boolean> };

  constructor(private readonly secrets: SecretsService) {}

  private entry(): Record<string, unknown> | undefined {
    const path = join(agentDirOf(process.env), 'models.json');
    if (!existsSync(path)) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('The models.json file could not be read. Fix its JSON before configuring LiteLLM.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The models.json file must contain an object.');
    const file = parsed as { providers?: Record<string, Record<string, unknown>> };
    return file.providers?.['litellm'];
  }

  status(): LiteLlmConnection {
    const entry = this.entry();
    const models = Array.isArray(entry?.['models']) ? entry['models'] as Record<string, unknown>[] : [];
    return {
      baseUrl: typeof entry?.['baseUrl'] === 'string' ? entry['baseUrl'] : 'http://localhost:4000/v1',
      configured: !!entry,
      hasApiKey: !!entry?.['apiKey'] && entry['apiKey'] !== 'litellm-no-key',
      models: models.flatMap((m) => typeof m['id'] === 'string' ? [{ id: m['id'], name: typeof m['name'] === 'string' ? m['name'] : m['id'],
        ...(typeof m['contextWindow'] === 'number' ? { contextWindow: m['contextWindow'] } : {}),
        ...(typeof m['maxTokens'] === 'number' ? { maxTokens: m['maxTokens'] } : {}),
        ...(typeof m['reasoning'] === 'boolean' ? { reasoning: m['reasoning'] } : {}),
        ...(Array.isArray(m['input']) ? { vision: m['input'].includes('image') } : {}),
      }] : []),
    };
  }

  private async key(input: LiteLlmConnect, signal?: AbortSignal): Promise<string | undefined> {
    if (input.apiKey !== undefined) return input.apiKey.trim() || undefined;
    const status = this.status();
    if (!status.hasApiKey) return undefined;
    if (liteLlmBaseUrl(status.baseUrl) !== liteLlmBaseUrl(input.baseUrl)) throw new Error('Enter the API key again when changing the proxy URL.');
    const pi = await loadPi();
    const runtime = await pi.ModelRuntime.create({ signal });
    let key: string | undefined;
    try { key = (await runtime.getAuth('litellm', { signal }))?.auth.apiKey; }
    catch { throw new Error('The saved LiteLLM API key could not be read. Enter it again.'); }
    if (!key) throw new Error('The saved LiteLLM API key could not be read. Enter it again.');
    return key;
  }

  async discover(input: LiteLlmConnect): Promise<LiteLlmConnection> {
    const key = await this.key(input);
    const catalog = await discoverLiteLlm(input.baseUrl, key);
    return { ...catalog, configured: this.status().configured, hasApiKey: !!key };
  }

  /** The picker refreshes the saved connection only. A failed probe keeps its last usable catalog. */
  async refreshCatalog(runtime: ModelRuntime): Promise<void> {
    try {
      const entry = this.entry();
      if (typeof entry?.['baseUrl'] !== 'string') return;
      const version = JSON.stringify(entry);
      let pending = this.refreshing;
      if (!pending || pending.version !== version) {
        pending = { version, request: this.refreshSavedCatalog(entry, version) };
        this.refreshing = pending;
      }
      try {
        if (await pending.request) await runtime.refresh({ allowNetwork: false });
      } finally {
        if (this.refreshing === pending) this.refreshing = undefined;
      }
    } catch {
      // Automatic refresh must not prevent picking a cached model or another provider.
    }
  }

  private async refreshSavedCatalog(entry: Record<string, unknown>, version: string): Promise<boolean> {
    const baseUrl = entry['baseUrl'] as string;
    const signal = AbortSignal.timeout(3000);
    const key = await this.key({ baseUrl }, signal);
    if (JSON.stringify(this.entry()) !== version) return false;
    const catalog = await discoverLiteLlm(baseUrl, key, fetch, signal);
    // A settings save while discovery was running wins, including changed credentials or a removed connection.
    if (JSON.stringify(this.entry()) !== version) return false;
    const details = liteLlmModelDetails(catalog.models);
    const known = Array.isArray(entry['models']) ? entry['models'] as { id?: string }[] : [];
    const next = catalog.models.map((m) => ({ ...known.find((k) => k.id === m.id), ...details[m.id], id: m.id }));
    if (JSON.stringify(known) === JSON.stringify(next)) return false;
    saveLocalProvider(agentDirOf(process.env), {
      provider: 'litellm', baseUrl: catalog.baseUrl, models: catalog.models.map((m) => m.id), modelDetails: details,
    });
    return true;
  }

  async save(input: LiteLlmConnect): Promise<LiteLlmConnection> {
    const catalog = await this.discover(input);
    if (!catalog.models.length) throw new Error('LiteLLM lists no chat models for this key. Add or grant access to a model on the proxy, then refresh.');
    const previous = this.entry();
    const key = input.apiKey?.trim();
    // No secret leaves this service. The models file uses the same keychain resolver as other providers.
    const apiKey = input.apiKey === undefined && previous?.['apiKey']
      ? previous['apiKey']
      : key ? (await this.secrets.keep('litellm', key)).value : 'litellm-no-key';
    saveLocalProvider(agentDirOf(process.env), {
      provider: 'litellm', baseUrl: catalog.baseUrl, models: catalog.models.map((m) => m.id),
      modelDetails: liteLlmModelDetails(catalog.models),
      providerDetails: { name: 'LiteLLM', api: 'openai-completions', apiKey, authHeader: catalog.hasApiKey },
    });
    return { ...catalog, configured: true };
  }
}
