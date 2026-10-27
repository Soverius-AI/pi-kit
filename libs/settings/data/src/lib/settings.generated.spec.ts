import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  connectorsCatalog,
  connectorsConnect,
  connectorsDisconnect,
  connectorsExposure,
  fakeBackend,
  mcpCancelSignIn,
  mcpEnabled,
  mcpLogin,
  mcpLogout,
  mcpOverview,
  mcpPasteSignIn,
  mcpReconnect,
  mcpReload,
  secretsInstall,
  secretsMove,
  secretsProtection,
  secretsRecoveryKey,
  secretsStatus,
  sessionReload,
  settingsAnswer,
  settingsCancel,
  settingsDiagnose,
  settingsListResources,
  settingsLogout,
  settingsRemoveProvider,
  settingsOverview,
  settingsPatch,
  settingsRevokeTrust,
  settingsSaveKeybindings,
  settingsStartLogin,
  settingsToggleResource,
  settingsTrustList,
  settingsValidate,
  setupDetect,
  setupReady,
  setupSaveLocal,
  setupScratch,
  setupState,
  setupTestLocal,
  unwrap,
} from '@pi-kit/api';

/** What goes on the wire for each call: the typed client runs for real, over a stand-in for the backend. */
function setup() {
  const backend = fakeBackend();
  TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: backend.apiClient }] });
  return backend;
}

describe('generated operations', () => {
  it.each([
    [
      'overview',
      (api: ApiClient) =>
        unwrap(settingsOverview({ client: api.client, signal: undefined, query: { cwd: undefined } })),
      'GET',
      '/api/pi-settings',
      undefined,
    ],
    [
      'overview for a folder',
      (api: ApiClient) =>
        unwrap(settingsOverview({ client: api.client, signal: undefined, query: { cwd: '/work/my proj' } })),
      'GET',
      '/api/pi-settings?cwd=%2Fwork%2Fmy%20proj',
      undefined,
    ],
    [
      'patch',
      (api: ApiClient) =>
        unwrap(settingsPatch({ client: api.client, query: { cwd: '/p' }, body: { autoCompaction: false } })),
      'PATCH',
      '/api/pi-settings?cwd=%2Fp',
      { autoCompaction: false },
    ],
    [
      'startLogin',
      (api: ApiClient) =>
        unwrap(settingsStartLogin({ client: api.client, body: { provider: 'openai', type: 'api_key' } })).then(
          ({ id }) => id,
        ),
      'POST',
      '/api/auth/login',
      { provider: 'openai', type: 'api_key' },
    ],
    [
      'answerLogin',
      (api: ApiClient) =>
        unwrap(
          settingsAnswer({ client: api.client, path: { id: 'l1' }, body: { promptId: 'p1', value: 'sk-made-up' } }),
        ),
      'POST',
      '/api/auth/login/l1/answer',
      { promptId: 'p1', value: 'sk-made-up' },
    ],
    [
      'cancelLogin',
      (api: ApiClient) => unwrap(settingsCancel({ client: api.client, path: { id: 'l1' } })),
      'POST',
      '/api/auth/login/l1/cancel',
      undefined,
    ],
    [
      'logout',
      (api: ApiClient) => unwrap(settingsLogout({ client: api.client, body: { provider: 'openai' } })),
      'POST',
      '/api/auth/logout',
      { provider: 'openai' },
    ],
    [
      'removeProvider',
      (api: ApiClient) => unwrap(settingsRemoveProvider({ client: api.client, body: { provider: 'litellm' } })),
      'POST',
      '/api/providers/remove',
      { provider: 'litellm' },
    ],
    [
      'validateKey',
      (api: ApiClient) => unwrap(settingsValidate({ client: api.client, body: { provider: 'openai' } })),
      'POST',
      '/api/auth/validate',
      { provider: 'openai' },
    ],
    [
      'saveKeybindings',
      (api: ApiClient) =>
        unwrap(settingsSaveKeybindings({ client: api.client, body: { overrides: { 'app.session.new': ['ctrl+n'] } } })),
      'PUT',
      '/api/pi-keybindings',
      { overrides: { 'app.session.new': ['ctrl+n'] } },
    ],
    [
      'resources',
      (api: ApiClient) =>
        unwrap(settingsListResources({ client: api.client, signal: undefined, query: { cwd: undefined } })),
      'GET',
      '/api/resources',
      undefined,
    ],
    [
      'toggleResource',
      (api: ApiClient) =>
        unwrap(settingsToggleResource({ client: api.client, query: { cwd: '/p' }, body: { key: 'k', enabled: true } })),
      'POST',
      '/api/resources/toggle?cwd=%2Fp',
      { key: 'k', enabled: true },
    ],
    [
      'diagnostics',
      (api: ApiClient) => unwrap(settingsDiagnose({ client: api.client })),
      'GET',
      '/api/diagnostics',
      undefined,
    ],
    [
      'trustList',
      (api: ApiClient) => unwrap(settingsTrustList({ client: api.client })),
      'GET',
      '/api/trust',
      undefined,
    ],
    [
      'revokeTrust',
      (api: ApiClient) => unwrap(settingsRevokeTrust({ client: api.client, body: { path: '/p' } })),
      'POST',
      '/api/trust/revoke',
      { path: '/p' },
    ],
    [
      'reloadThread',
      (api: ApiClient) => unwrap(sessionReload({ client: api.client, path: { id: 't1' } })),
      'POST',
      '/api/threads/t1/reload',
      undefined,
    ],
  ])('%s sends the method, path and body the contract names', async (_name, call, method, path, body) => {
    const backend = setup();
    backend.reply({ id: 'l1' });
    await call(TestBed.inject(ApiClient));
    expect(backend.calls[0]).toMatchObject({ method, path });
    expect(backend.calls[0].body).toEqual(body);
  });

  it('startLogin answers with the id of the flow', async () => {
    const backend = setup();
    backend.reply({ id: 'login-7' }, 201);
    expect(
      await unwrap(
        settingsStartLogin({ client: TestBed.inject(ApiClient).client, body: { provider: 'openai', type: 'oauth' } }),
      ).then(({ id }) => id),
    ).toBe('login-7');
  });

  it('a rejected sign-in answer is an Error with the backend’s message', async () => {
    const backend = setup();
    backend.fail(409, 'That question is no longer waiting for an answer.');
    await expect(
      unwrap(
        settingsAnswer({
          client: TestBed.inject(ApiClient).client,
          path: { id: 'l1' },
          body: { promptId: 'p1', value: 'x' },
        }),
      ),
    ).rejects.toThrow('That question is no longer waiting for an answer.');
  });
});

describe('generated operations', () => {
  it.each([
    [
      'detect',
      (api: ApiClient) => unwrap(setupDetect({ client: api.client, signal: undefined })),
      'GET',
      '/api/setup',
      undefined,
    ],
    [
      'setState',
      (api: ApiClient) => unwrap(setupState({ client: api.client, body: { state: 'skipped' } })),
      'POST',
      '/api/setup/state',
      { state: 'skipped' },
    ],
    [
      'testLocal',
      (api: ApiClient) => unwrap(setupTestLocal({ client: api.client, body: { baseUrl: 'http://127.0.0.1:8080/v1' } })),
      'POST',
      '/api/setup/local/test',
      { baseUrl: 'http://127.0.0.1:8080/v1' },
    ],
    [
      'saveLocal',
      (api: ApiClient) =>
        unwrap(
          setupSaveLocal({
            client: api.client,
            body: { provider: 'local', baseUrl: 'http://127.0.0.1:8080/v1', models: ['m1'] },
          }),
        ),
      'POST',
      '/api/setup/local/save',
      { provider: 'local', baseUrl: 'http://127.0.0.1:8080/v1', models: ['m1'] },
    ],
    [
      'scratch',
      (api: ApiClient) => unwrap(setupScratch({ client: api.client })),
      'POST',
      '/api/setup/scratch',
      undefined,
    ],
    [
      'ready',
      (api: ApiClient) => unwrap(setupReady({ client: api.client, body: { provider: 'local', modelId: 'm1' } })),
      'POST',
      '/api/setup/ready',
      { provider: 'local', modelId: 'm1' },
    ],
  ])('%s sends the method, path and body the contract names', async (_name, call, method, path, body) => {
    const backend = setup();
    backend.reply({});
    await call(TestBed.inject(ApiClient));
    expect(backend.calls[0]).toMatchObject({ method, path });
    expect(backend.calls[0].body).toEqual(body);
  });
});

describe('generated operations', () => {
  it.each([
    [
      'overview without a thread',
      (api: ApiClient) => unwrap(mcpOverview({ client: api.client, query: { thread: undefined } })),
      'GET',
      '/api/mcp',
      undefined,
    ],
    [
      'overview',
      (api: ApiClient) => unwrap(mcpOverview({ client: api.client, query: { thread: 't 1' } })),
      'GET',
      '/api/mcp?thread=t%201',
      undefined,
    ],
    [
      'reload',
      (api: ApiClient) => unwrap(mcpReload({ client: api.client, query: { thread: 't1' } })),
      'POST',
      '/api/mcp/reload?thread=t1',
      undefined,
    ],
    [
      'setEnabled',
      (api: ApiClient) =>
        unwrap(
          mcpEnabled({
            client: api.client,
            path: { name: 'docs/x' },
            query: { thread: 't1' },
            body: { enabled: false },
          }),
        ),
      'POST',
      '/api/mcp/servers/docs%2Fx/enabled?thread=t1',
      { enabled: false },
    ],
    [
      'reconnect',
      (api: ApiClient) => unwrap(mcpReconnect({ client: api.client, path: { name: 'docs' }, query: { thread: 't1' } })),
      'POST',
      '/api/mcp/servers/docs/reconnect?thread=t1',
      undefined,
    ],
    [
      'login',
      (api: ApiClient) => unwrap(mcpLogin({ client: api.client, path: { name: 'docs' }, query: { thread: 't1' } })),
      'POST',
      '/api/mcp/servers/docs/login?thread=t1',
      undefined,
    ],
    [
      'logout',
      (api: ApiClient) => unwrap(mcpLogout({ client: api.client, path: { name: 'docs' }, query: { thread: 't1' } })),
      'POST',
      '/api/mcp/servers/docs/logout?thread=t1',
      undefined,
    ],
    [
      'cancelSignIn',
      (api: ApiClient) =>
        unwrap(mcpCancelSignIn({ client: api.client, path: { name: 'docs' }, query: { thread: 't1' } })),
      'POST',
      '/api/mcp/servers/docs/signin/cancel?thread=t1',
      undefined,
    ],
    [
      'pasteSignIn',
      (api: ApiClient) =>
        unwrap(
          mcpPasteSignIn({
            client: api.client,
            path: { name: 'docs' },
            query: { thread: 't1' },
            body: { url: 'http://127.0.0.1:1/cb?code=x' },
          }),
        ),
      'POST',
      '/api/mcp/servers/docs/signin/paste?thread=t1',
      { url: 'http://127.0.0.1:1/cb?code=x' },
    ],
    [
      'catalog',
      (api: ApiClient) => unwrap(connectorsCatalog({ client: api.client })),
      'GET',
      '/api/connectors/catalog',
      undefined,
    ],
    [
      'connect without a thread',
      (api: ApiClient) =>
        unwrap(
          connectorsConnect({
            client: api.client,
            query: { thread: undefined },
            body: { id: 'linear', scope: 'user' },
          }),
        ),
      'POST',
      '/api/connectors/connect',
      { id: 'linear', scope: 'user' },
    ],
    [
      'disconnect',
      (api: ApiClient) =>
        unwrap(connectorsDisconnect({ client: api.client, path: { name: 'linear' }, query: { thread: 't1' } })),
      'POST',
      '/api/connectors/linear/disconnect?thread=t1',
      undefined,
    ],
    [
      'setExposure',
      (api: ApiClient) =>
        unwrap(
          connectorsExposure({
            client: api.client,
            path: { name: 'linear' },
            query: { thread: 't1' },
            body: { exposure: 'deferred' },
          }),
        ),
      'POST',
      '/api/connectors/linear/exposure?thread=t1',
      { exposure: 'deferred' },
    ],
  ])('%s sends the method, path and body the contract names', async (_name, call, method, path, body) => {
    const backend = setup();
    backend.reply({});
    await call(TestBed.inject(ApiClient));
    expect(backend.calls[0]).toMatchObject({ method, path });
    expect(backend.calls[0].body).toEqual(body);
  });

  it('sends a token once, in the body, and never in the address', async () => {
    const backend = setup();
    backend.reply({});
    await unwrap(
      connectorsConnect({
        client: TestBed.inject(ApiClient).client,
        query: { thread: 't1' },
        body: { id: 'linear', scope: 'user', token: 'lin_api_made_up' },
      }),
    );
    expect(backend.calls[0].path).not.toContain('lin_api');
    expect(backend.calls[0].body).toMatchObject({ token: 'lin_api_made_up' });
  });
});

describe('generated operations', () => {
  it.each([
    ['status', (api: ApiClient) => unwrap(secretsStatus({ client: api.client })), 'GET', '/api/secrets'],
    [
      'protection',
      (api: ApiClient) => unwrap(secretsProtection({ client: api.client })),
      'GET',
      '/api/secrets/protection',
    ],
    ['moveKeys', (api: ApiClient) => unwrap(secretsMove({ client: api.client })), 'POST', '/api/secrets/move'],
    [
      'installCli',
      (api: ApiClient) => unwrap(secretsInstall({ client: api.client })),
      'POST',
      '/api/secrets/cli/install',
    ],
    [
      'recoveryKey',
      (api: ApiClient) => unwrap(secretsRecoveryKey({ client: api.client })),
      'POST',
      '/api/secrets/recovery-key',
    ],
  ])('%s sends the method and path the contract names', async (_name, call, method, path) => {
    const backend = setup();
    backend.reply({});
    await call(TestBed.inject(ApiClient));
    expect(backend.calls[0]).toMatchObject({ method, path });
    expect(backend.calls[0].body).toBeUndefined();
  });

  it('a second request for the recovery key is the backend’s refusal, said as it is', async () => {
    const backend = setup();
    backend.fail(409, 'The recovery key was shown once already and is not shown again.');
    await expect(unwrap(secretsRecoveryKey({ client: TestBed.inject(ApiClient).client }))).rejects.toThrow(
      'not shown again',
    );
  });
});
