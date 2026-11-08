import {
  type LoginEvent,
  settingsAnswer,
  settingsCancel,
  settingsLogout,
  settingsOverview,
  settingsPatch,
  settingsStartLogin,
  setupSaveLocal,
  setupTestLocal,
} from '@pi-kit/api/generated';
import { localProviderId } from '@pi-kit/protocol';
import type { BackendEndpoint } from './backend';
import { callHost } from './cli-host';
import type { CliContext, CliIo } from './service-cli';

export const SETTINGS_USAGE = `Model commands:
  pi-kit login [<provider>]         Sign in to a provider with its own flow (--api-key or --oauth where it offers both)
  pi-kit login --local <url>        Add a local model server (llama.cpp, llama-swap, Ollama, any OpenAI-compatible one)
  pi-kit logout <provider>          Remove a provider's stored sign-in
  pi-kit model [<provider>/<id>]    Show or set the default model for new threads
`;

type Call = { baseUrl: string; auth: string; throwOnError: true };

async function backend(ctx: CliContext): Promise<Call> {
  const { url, token } = await callHost<BackendEndpoint>(ctx, 'backend');
  return { baseUrl: url, auth: token, throwOnError: true };
}

/** `pi-kit login`: the sign-in flow Settings runs, rendered in the terminal; keys and pasted codes are read without echo. */
export async function runLoginCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  const local = args[0] === '--local' ? args[1] : undefined;
  if (args[0] === '--local') return local && args.length === 2 ? addLocal(local, io, ctx) : usage(io);
  const flags = args.filter((arg) => arg.startsWith('--'));
  const named = args.filter((arg) => !arg.startsWith('--'));
  if (named.length > 1 || flags.some((flag) => flag !== '--api-key' && flag !== '--oauth') || flags.length > 1)
    return usage(io);
  const call = await backend(ctx);
  const { providers } = (await settingsOverview(call)).data;
  const choices = providers.filter((provider) => provider.methods.length > 0);
  const wanted =
    named[0] ??
    (io.interactive
      ? (
          await pick(
            io,
            choices.map((p) => `${p.id}  ${p.name}`),
          )
        )?.split(' ')[0]
      : undefined);
  const provider = choices.find((p) => p.id === wanted);
  if (!provider) {
    io.err(`pi-kit: name a provider: ${choices.map((p) => p.id).join(', ')}\n`);
    return 2;
  }
  const type =
    flags[0] === '--api-key'
      ? 'api_key'
      : flags[0] === '--oauth'
        ? 'oauth'
        : provider.methods.length === 1
          ? provider.methods[0]
          : undefined;
  if (!type || !provider.methods.includes(type)) {
    io.err(
      `pi-kit: ${provider.name} signs in with ${provider.methods.map((m) => (m === 'api_key' ? '--api-key' : '--oauth')).join(' or ')}.\n`,
    );
    return 2;
  }
  const { id } = (await settingsStartLogin({ ...call, body: { provider: provider.id, type } })).data;
  for await (const event of loginEvents(call, id)) {
    const outcome = await render(event, io);
    if (outcome === 'done') break;
    if (outcome instanceof Error) {
      io.err(`pi-kit: ${outcome.message}\n`);
      return 1;
    }
    if (outcome === undefined) continue;
    if (outcome.value === undefined) {
      await settingsCancel({ ...call, path: { id } });
      io.err(
        io.interactive
          ? 'pi-kit: sign-in cancelled.\n'
          : 'pi-kit: this sign-in asks questions; run it in a terminal.\n',
      );
      return 1;
    }
    await settingsAnswer({ ...call, path: { id }, body: { promptId: outcome.promptId, value: outcome.value } });
  }
  const signedIn = (await settingsOverview(call)).data.providers.find((p) => p.id === provider.id);
  const store = signedIn?.credential?.store;
  io.out(
    `Signed in to ${provider.name}${store ? `; the credential is in ${store === 'keychain' ? 'the OS credential store' : store}` : ''}.\n`,
  );
  return 0;
}

/** `pi-kit logout <provider>`. */
export async function runLogoutCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  if (args.length !== 1) return usage(io);
  await settingsLogout({ ...(await backend(ctx)), body: { provider: args[0] } });
  io.out(`Signed out of ${args[0]}.\n`);
  return 0;
}

/** `pi-kit model [<provider>/<id>]`: pi's default model for new threads. */
export async function runModelCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  if (args.length > 1) return usage(io);
  const call = await backend(ctx);
  const { settings, models } = (await settingsOverview(call)).data;
  if (!args[0]) {
    io.out(
      settings.defaultProvider && settings.defaultModel
        ? `${settings.defaultProvider}/${settings.defaultModel}\n`
        : 'No default model.\n',
    );
    for (const model of models.filter((m) => m.available)) io.err(`  ${model.provider}/${model.id}  ${model.name}\n`);
    return 0;
  }
  const slash = args[0].indexOf('/');
  const [provider, modelId] = [args[0].slice(0, slash), args[0].slice(slash + 1)];
  if (slash < 1 || !models.some((m) => m.available && m.provider === provider && m.id === modelId)) {
    io.err(`pi-kit: no available model ${args[0]}; "pi-kit model" lists them.\n`);
    return 2;
  }
  await settingsPatch({ ...call, body: { defaultModel: { provider, modelId } } });
  io.out(`New threads use ${provider}/${modelId}.\n`);
  return 0;
}

async function addLocal(baseUrl: string, io: CliIo, ctx: CliContext): Promise<number> {
  const call = await backend(ctx);
  const found = (await setupTestLocal({ ...call, body: { baseUrl } })).data;
  if (!found.ok || found.models.length === 0) {
    io.err(`pi-kit: ${found.error ?? 'the server lists no models; load one first'}.\n`);
    return 1;
  }
  const provider = localProviderId(found.kind);
  const saved = (await setupSaveLocal({ ...call, body: { provider, baseUrl: found.baseUrl, models: found.models } }))
    .data;
  io.out(`Added ${saved.models} models from ${found.baseUrl} as ${saved.provider}.\n`);
  return 0;
}

/** The sign-in's events, one JSON object per line, as Settings reads them. */
async function* loginEvents(call: Call, id: string): AsyncGenerator<LoginEvent> {
  const response = await fetch(`${call.baseUrl}/api/auth/login/${encodeURIComponent(id)}/events`, {
    headers: { authorization: `Bearer ${call.auth}` },
  });
  if (!response.ok || !response.body) throw new Error(`the sign-in stream answered ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as LoginEvent;
    }
  }
}

/** Prints an event; a prompt comes back with the owner's answer (undefined when they gave none). */
async function render(
  event: LoginEvent,
  io: CliIo,
): Promise<'done' | Error | { promptId: string; value: string | undefined } | undefined> {
  switch (event.type) {
    case 'info':
      io.out(
        `${event.message}\n${(event.links ?? []).map((link) => `  ${link.label ?? 'Link'}: ${link.url}\n`).join('')}`,
      );
      return undefined;
    case 'auth_url':
      io.out(
        `Open this link in any browser to sign in:\n  ${event.url}\n${event.instructions ? `${event.instructions}\n` : ''}`,
      );
      return undefined;
    case 'device_code':
      io.out(`Open ${event.verificationUri} and enter the code ${event.userCode}.\n`);
      return undefined;
    case 'progress':
      io.err(`${event.message}\n`);
      return undefined;
    case 'prompt': {
      if (!io.interactive) return { promptId: event.promptId, value: undefined };
      const label = `${event.message}${event.placeholder ? ` (${event.placeholder})` : ''}: `;
      if (event.kind === 'select') {
        const options = event.options ?? [];
        const chosen = await pick(
          io,
          options.map((option) => option.label),
          event.message,
        );
        return { promptId: event.promptId, value: options.find((option) => option.label === chosen)?.id };
      }
      const read = event.kind === 'text' ? io.readLine : (io.readSecret ?? io.readLine);
      return { promptId: event.promptId, value: (await read?.(label))?.trim() || undefined };
    }
    case 'done':
      return 'done';
    case 'error':
      return new Error(event.message);
    default:
      return undefined;
  }
}

/** One of `choices`, by its number, from the terminal. */
async function pick(io: CliIo, choices: string[], title = 'Choose one'): Promise<string | undefined> {
  io.out(`${title}:\n${choices.map((choice, i) => `  ${i + 1}. ${choice}\n`).join('')}`);
  const answer = Number((await io.readLine?.('Number: '))?.trim());
  return Number.isInteger(answer) ? choices[answer - 1] : undefined;
}

function usage(io: CliIo): number {
  io.err(SETTINGS_USAGE);
  return 2;
}
