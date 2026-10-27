import type { Translate } from '@pi-kit/i18n';
import {
  type ConnectRequest,
  type Connector,
  type ConnectorCatalog,
  type ConnectorExposure,
  type CustomConnector,
  connectorById,
} from '@pi-kit/protocol';

/**
 * The "Add a server" wizard as a step machine with no Angular: the catalog gallery (search, "For me / This project
 * only", "Your own server" last), then the details (a service from the catalog asks only for what its sign-in needs; a server of your own asks for a name, a URL or a command,
 * and how its tools reach the model), with a reachability check before "Add and connect". What the form types as a secret is never in this state: the component reads it from
 * its field when the form is sent.
 */

export const CUSTOM = 'custom';
export type AddServerStep = 'gallery' | 'details';

/** What the details form holds besides secrets. */
export interface ServerDraft {
  name: string;
  kind: 'url' | 'command';
  url: string;
  /** The executable and its arguments on one line; {@link splitCommand} makes them two. */
  command: string;
  exposure: ConnectorExposure;
  description: string;
  /** The access variant of a catalog service that has several (Linear read-only), or ''. */
  variant: string;
  /** The client id of the person's own app (a service that signs in with one). */
  clientId: string;
}

export interface AddServerState {
  step: AddServerStep;
  /** The tile picked: a catalog id, or {@link CUSTOM}. */
  choice?: string;
  direction: 'forward' | 'back';
  query: string;
  scope: 'user' | 'project';
  draft: ServerDraft;
}

const BLANK: ServerDraft = {
  name: '',
  kind: 'url',
  url: '',
  command: '',
  exposure: 'codemode',
  description: '',
  variant: '',
  clientId: '',
};

export function startAddServer(scope: 'user' | 'project' = 'user'): AddServerState {
  return { step: 'gallery', direction: 'forward', query: '', scope, draft: { ...BLANK } };
}

/** A tile is picked: the details follow, with the catalog service's own defaults (its exposure; its name, which is what `mcp.json` calls it). */
export function chooseServer(state: AddServerState, id: string, catalog: ConnectorCatalog): AddServerState {
  const connector = id === CUSTOM ? undefined : connectorById(id, catalog);
  const draft: ServerDraft = connector ? { ...BLANK, name: connector.id, exposure: connector.exposure } : { ...BLANK };
  return { ...state, step: 'details', choice: connector ? id : CUSTOM, direction: 'forward', draft };
}

/** The wizard opened straight on a service's details (the sign-in of a connector that needs a token or a client id lands here). */
export function startAt(id: string, catalog: ConnectorCatalog, scope: 'user' | 'project' = 'user'): AddServerState {
  return chooseServer(startAddServer(scope), id, catalog);
}

export function backToGallery(state: AddServerState): AddServerState {
  return { ...state, step: 'gallery', direction: 'back' };
}

export function patchDraft(state: AddServerState, patch: Partial<ServerDraft>): AddServerState {
  return { ...state, draft: { ...state.draft, ...patch } };
}

/** The gallery's search: name, vendor, what it does and the words a person would use (Jira finds Atlassian). */
export function filterCatalog(catalog: ConnectorCatalog, query: string): Connector[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...catalog.connectors];
  return catalog.connectors.filter((c) =>
    [c.id, c.name, c.vendor, c.summary, c.scopes, ...(c.highlights ?? [])].some((text) =>
      text.toLowerCase().includes(q),
    ),
  );
}

/** "Your own server" is a tile of the gallery too; it shows with an empty search, or one that names it. */
export function showsCustom(query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || 'your own server custom url command'.includes(q) || /(url|command|custom|own)/.test(q);
}

/** A command line split on spaces, with "double" and 'single' quotes keeping words together (pi takes one executable and its arguments, not a shell string). */
export function splitCommand(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const NAME = /^[A-Za-z0-9_-]+$/;
const HTTPS = /^https:\/\/\S+$/;
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/\S*)?$/;

/** Whether an address may be a server's: https, or http on this machine. */
export function validUrl(url: string): boolean {
  return HTTPS.test(url) || LOCAL_HTTP.test(url);
}

export interface FormProblem {
  field: 'name' | 'url' | 'command' | 'token' | 'clientId';
  message: string;
}

/** What is wrong with the details so far, or nothing. `secrets` says which secret fields hold text (never the text). */
export function validateServer(
  translate: Translate,
  state: AddServerState,
  catalog: ConnectorCatalog,
  secrets: { token?: boolean; clientId?: boolean } = {},
): FormProblem | undefined {
  const connector = state.choice && state.choice !== CUSTOM ? connectorById(state.choice, catalog) : undefined;
  const d = state.draft;
  if (!connector) {
    if (!NAME.test(d.name))
      return { field: 'name', message: translate('settings.addServer.giveItANameOfLettersDigits') };
    if (d.kind === 'url') {
      if (!validUrl(d.url.trim()))
        return { field: 'url', message: translate('settings.addServer.aRemoteServerSURLStartsWith') };
    } else if (splitCommand(d.command).length === 0)
      return { field: 'command', message: translate('settings.addServer.typeTheCommandThatStartsTheServer') };
    return undefined;
  }
  if (connector.auth.type === 'bearer' && !secrets.token)
    return { field: 'token', message: translate('settings.addServer.pasteTheTokenFirst') };
  if (connector.auth.type === 'oauth-client' && !d.clientId.trim())
    return { field: 'clientId', message: translate('settings.addServer.typeTheClientIDOfYourApp') };
  return undefined;
}

/** The custom server the details describe. */
export function customOf(d: ServerDraft): CustomConnector {
  const description = d.description.trim();
  if (d.kind === 'url') return { name: d.name.trim(), url: d.url.trim(), ...(description ? { description } : {}) };
  const parts = splitCommand(d.command);
  return {
    name: d.name.trim(),
    command: parts[0],
    ...(parts.length > 1 ? { args: parts.slice(1) } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * The request "Add and connect" sends. The secrets are arguments, read from their fields a moment before, and go into the request only; this function keeps no copy.
 * A project-only server cannot carry a credential (mcp.md: credentials stay in the user file), so the scope falls back to the user file when one is typed.
 */
export function connectRequest(
  state: AddServerState,
  catalog: ConnectorCatalog,
  secrets: { token?: string; clientSecret?: string } = {},
): ConnectRequest | undefined {
  if (!state.choice) return undefined;
  const d = state.draft;
  const credential =
    !!secrets.token ||
    !!secrets.clientSecret ||
    (state.choice !== CUSTOM &&
      ['bearer', 'oauth-client'].includes(connectorById(state.choice, catalog)?.auth.type ?? ''));
  const scope = credential ? 'user' : state.scope;
  if (state.choice === CUSTOM) {
    return {
      id: CUSTOM,
      scope,
      exposure: d.exposure,
      custom: customOf(d),
      ...(d.kind === 'url' && secrets.token ? { token: secrets.token } : {}),
    };
  }
  return {
    id: state.choice,
    scope,
    exposure: d.exposure,
    ...(d.variant ? { variant: d.variant } : {}),
    ...(secrets.token ? { token: secrets.token } : {}),
    ...(d.clientId.trim() ? { clientId: d.clientId.trim() } : {}),
    ...(secrets.clientSecret ? { clientSecret: secrets.clientSecret } : {}),
  };
}

/** Whether "This project only" can be offered for the tile: it needs a thread in a trusted folder and no credential in the file. */
export function projectAllowed(choice: string | undefined, catalog: ConnectorCatalog, hasThread: boolean): boolean {
  if (!hasThread) return false;
  if (!choice || choice === CUSTOM) return true;
  const auth = connectorById(choice, catalog)?.auth.type;
  return auth === 'oauth' || auth === 'cimd';
}

/** The text under the form's footer: where the entry is written. */
export function footHint(translate: Translate, state: AddServerState): string {
  return state.step === 'gallery'
    ? translate('settings.addServer.step1Of2NextDetails')
    : translate('settings.addServer.step2Of2');
}

/** The label of the primary button. */
export function primaryText(translate: Translate, state: AddServerState, catalog: ConnectorCatalog): string {
  if (state.step === 'gallery') return translate('settings.addServer.continue');
  const connector = state.choice && state.choice !== CUSTOM ? connectorById(state.choice, catalog) : undefined;
  return connector && connector.auth.type === 'oauth'
    ? translate('settings.addServer.addAndSignIn')
    : translate('settings.addServer.addAndConnect');
}
