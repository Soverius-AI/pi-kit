import { english } from '@pi-kit/i18n/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CONNECTOR_CATALOG, type McpCheckResult, type McpServer } from '@pi-kit/protocol';
import { ConnectorsStore, SecretsStore } from '@pi-kit/settings/api';
import { mcpRows } from '@pi-kit/settings/util';
import { AddServerWizard } from './add-server-wizard';

describe('AddServerWizard', () => {
  const wizard = signal<{ id?: string } | undefined>({});
  const servers = signal<McpServer[]>([]);
  const store = {
    wizard,
    catalog: signal(CONNECTOR_CATALOG),
    servers,
    rows: () => mcpRows(english, CONNECTOR_CATALOG, servers()),
    busy: signal(new Set<string>()),
    notice: signal<{ level: 'info' | 'error'; text: string; trust?: boolean; server?: string } | undefined>(undefined),
    threadId: () => 't1' as string | undefined,
    choiceOf: () => ({ scope: 'user' as const }),
    loadCatalog: vi.fn(async () => undefined),
    check: vi.fn(async (): Promise<McpCheckResult> => ({
      ok: true,
      status: 'reachable',
      message: 'Answered in 12 ms · 3 tools: search, open, list.',
    })),
    add: vi.fn(async () => true),
    addServer: vi.fn(async () => true),
    setExposure: vi.fn(async () => true),
    closeWizard: vi.fn(() => wizard.set(undefined)),
    trustFolder: vi.fn(),
  };
  const secrets = {
    status: signal({ available: true, label: 'macOS Keychain' }),
    loadStatus: vi.fn(async () => undefined),
  };

  const open = () => {
    const fixture = TestBed.createComponent(AddServerWizard);
    fixture.detectChanges();
    return fixture;
  };
  const root = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(f: { nativeElement: unknown }, selector: string): T | null =>
    root(f).querySelector<T>(selector);
  const type = (f: ReturnType<typeof open>, selector: string, value: string): void => {
    const input = q<HTMLInputElement>(f, selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    f.detectChanges();
  };
  const click = (f: ReturnType<typeof open>, selector: string): void => {
    q(f, selector)?.click();
    f.detectChanges();
  };
  const settle = async (f: ReturnType<typeof open>): Promise<void> => {
    await f.whenStable();
    f.detectChanges();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    wizard.set({});
    servers.set([]);
    store.notice.set(undefined);
    store.busy.set(new Set());
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ConnectorsStore, useValue: store },
        { provide: SecretsStore, useValue: secrets },
      ],
    });
  });

  it('starts with the catalog as a gallery, "Your own server" last, and a search and a scope select above it', () => {
    const f = open();
    const tiles = Array.from(root(f).querySelectorAll('.pk-choices.pk-gallery button')).map((b) =>
      b.getAttribute('data-testid'),
    );
    expect(tiles.slice(0, -1)).toEqual(CONNECTOR_CATALOG.connectors.map((c) => `tile-${c.id}`));
    expect(tiles.at(-1)).toBe('tile-custom');
    expect(q(f, '[data-testid=gallery-search]')).not.toBeNull();
    expect(
      Array.from(q<HTMLSelectElement>(f, '[data-testid=gallery-scope]')?.options ?? []).map((o) =>
        o.textContent?.trim(),
      ),
    ).toEqual(['For me', 'This project only']);
    expect(root(f).querySelectorAll('.dots i.on')).toHaveLength(1);
    expect(q(f, '.foot .hint')?.textContent).toBe('Step 1 of 2, next: details');
  });

  it('the search narrows the gallery', () => {
    const f = open();
    type(f, '[data-testid=gallery-search]', 'jira');
    expect(
      Array.from(root(f).querySelectorAll('.pk-gallery button')).map((b) => b.getAttribute('data-testid')),
    ).toEqual(['tile-atlassian']);
    type(f, '[data-testid=gallery-search]', 'zzzz');
    expect(root(f).textContent).toContain('No service matches');
  });

  it('a service that is already added says so on its tile', () => {
    servers.set([
      {
        name: 'linear',
        scope: 'global',
        source: '/u/mcp.json',
        transport: 'http',
        target: 'https://mcp.linear.app/mcp',
        exposure: 'deferred',
        enabled: true,
        state: 'connected',
        oauth: true,
      },
    ]);
    const f = open();
    expect(q(f, '[data-testid=tile-linear] .chip.ok')?.textContent).toBe('added');
    expect(q(f, '[data-testid=tile-notion] .chip.ok')).toBeNull();
  });

  it('a catalog service goes to its details and is added without a check; an OAuth one asks for no input', async () => {
    const f = open();
    click(f, '[data-testid=tile-linear]');
    expect(q(f, '[data-wstep=details]')).not.toBeNull();
    expect(q(f, '[data-testid=details-service]')?.textContent).toContain('Linear');
    expect(q(f, '[data-testid=connector-token]')).toBeNull();
    expect(q(f, '[data-testid=server-add]')?.textContent?.trim()).toBe('Add and sign in');
    expect(q(f, '[data-testid=check-server]')).toBeNull();
    click(f, '[data-testid=server-add]');
    await settle(f);
    expect(store.check).not.toHaveBeenCalled();
    expect(store.add).toHaveBeenCalledWith(expect.objectContaining({ id: 'linear', scope: 'user' }));
  });

  it('a token service asks for the token in a password field, says where it goes, and sends it once', async () => {
    const bearer = CONNECTOR_CATALOG.connectors.find((c) => c.auth.type === 'bearer')!;
    const f = open();
    click(f, `[data-testid=tile-${bearer.id}]`);
    const field = q<HTMLInputElement>(f, '[data-testid=connector-token]') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(root(f).textContent).toContain('macOS Keychain');
    click(f, '[data-testid=server-add]');
    expect(q(f, '[data-testid=server-error]')?.textContent).toBe('Paste the token first.');
    expect(store.add).not.toHaveBeenCalled();
    field.value = 'ghp_secret_token_value';
    click(f, '[data-testid=server-add]');
    await settle(f);
    expect(store.add).toHaveBeenCalledWith(expect.objectContaining({ id: bearer.id, token: 'ghp_secret_token_value' }));
    // the field is emptied before the request leaves, and the token is on no part of the page
    expect(field.value).toBe('');
    expect(root(f).innerHTML).not.toContain('ghp_secret_token_value');
  });

  it('a server of your own: refuses a bad name or address before anything is checked or written', async () => {
    const f = open();
    click(f, '[data-testid=tile-custom]');
    click(f, '[data-testid=server-add]');
    expect(q(f, '[data-testid=server-error]')?.textContent).toMatch(/letters, digits/);
    type(f, '[data-testid=custom-name]', 'docs-search');
    type(f, '[data-testid=custom-url]', 'http://example.com/mcp');
    click(f, '[data-testid=server-add]');
    expect(q(f, '[data-testid=server-error]')?.textContent).toMatch(/https:\/\//);
    expect(store.check).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
  });

  it('a server of your own: checks that it answers, shows the answer, then adds it with the request the form describes', async () => {
    const f = open();
    click(f, '[data-testid=tile-custom]');
    type(f, '[data-testid=custom-name]', 'docs-search');
    type(f, '[data-testid=custom-url]', 'https://docs.internal.example/mcp');
    type(f, '[data-testid=custom-description]', 'Internal docs');
    click(f, '[data-testid=headers-add]');
    type(f, '[data-testid=headers-key-0]', 'Authorization');
    type(f, '[data-testid=headers-value-0]', 'Bearer tok-123-abcdefghijklmnop');
    const value = q<HTMLInputElement>(f, '[data-testid=headers-value-0]') as HTMLInputElement;
    expect(value.type).toBe('password');
    click(f, '[data-testid=server-add]');
    await settle(f);
    // the token went to the check once (for that call only) and to the request once, with the mark that sends it to the keychain
    expect(store.check).toHaveBeenCalledWith({
      url: 'https://docs.internal.example/mcp',
      token: 'tok-123-abcdefghijklmnop',
    });
    expect(q(f, '[data-testid=check-result]')?.textContent).toContain('reachable');
    expect(store.addServer).toHaveBeenCalledWith({
      name: 'docs-search',
      kind: 'url',
      url: 'https://docs.internal.example/mcp',
      headers: [{ key: 'Authorization', value: 'Bearer tok-123-abcdefghijklmnop', secret: true }],
      exposure: 'codemode',
      description: 'Internal docs',
      enabled: true,
      scope: 'user',
    });
    // the secret is on no part of the page, and "As it will be written" names the command that prints it
    expect(root(f).innerHTML).not.toContain('tok-123-abcdefghijklmnop');
    expect(q(f, '[data-testid=as-written-text]')?.textContent).toContain(
      '"Authorization": "!pi-kit-secret get mcp-docs-search-header-Authorization"',
    );
  });

  it('a server of your own as a command: arguments and environment rows, and a variable that is not a secret stays plain', async () => {
    const f = open();
    click(f, '[data-testid=tile-custom]');
    type(f, '[data-testid=custom-name]', 'files');
    const kind = q<HTMLSelectElement>(f, '[data-testid=custom-kind]') as HTMLSelectElement;
    kind.value = 'command';
    kind.dispatchEvent(new Event('change'));
    f.detectChanges();
    type(f, '[data-testid=custom-command]', 'npx');
    type(f, '[data-testid=custom-args]', '-y server-files "a b"');
    click(f, '[data-testid=env-add]');
    type(f, '[data-testid=env-key-0]', 'ROOT');
    type(f, '[data-testid=env-value-0]', '/srv/data');
    click(f, '[data-testid=env-add]');
    type(f, '[data-testid=env-key-1]', 'API_KEY');
    type(f, '[data-testid=env-value-1]', 'abc-123');
    expect((q(f, '[data-testid=env-value-0]') as HTMLInputElement).type).toBe('text');
    expect((q(f, '[data-testid=env-value-1]') as HTMLInputElement).type).toBe('password');
    click(f, '[data-testid=server-add]');
    await settle(f);
    expect(store.check).toHaveBeenCalledWith({ command: 'npx' });
    expect(store.addServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'files',
        kind: 'command',
        command: 'npx',
        args: ['-y', 'server-files', 'a b'],
        env: [
          { key: 'ROOT', value: '/srv/data' },
          { key: 'API_KEY', value: 'abc-123', secret: true },
        ],
      }),
    );
  });

  it('a check that fails stops the add once, and "Add anyway" goes ahead', async () => {
    store.check.mockResolvedValueOnce({
      ok: false,
      status: 'unreachable',
      message: 'Could not reach it: ECONNREFUSED.',
    });
    const f = open();
    click(f, '[data-testid=tile-custom]');
    type(f, '[data-testid=custom-name]', 'mine');
    click(f, '[data-testid=custom-kind]');
    const kind = q<HTMLSelectElement>(f, '[data-testid=custom-kind]') as HTMLSelectElement;
    kind.value = 'command';
    kind.dispatchEvent(new Event('change'));
    f.detectChanges();
    type(f, '[data-testid=custom-command]', 'npx');
    type(f, '[data-testid=custom-args]', '-y missing-mcp');
    click(f, '[data-testid=server-add]');
    await settle(f);
    expect(store.check).toHaveBeenCalledWith({ command: 'npx' });
    expect(store.addServer).not.toHaveBeenCalled();
    expect(q(f, '[data-testid=check-result]')?.getAttribute('data-status')).toBe('unreachable');
    expect(q(f, '[data-testid=server-add]')?.textContent?.trim()).toBe('Add anyway');
    click(f, '[data-testid=server-add]');
    await settle(f);
    expect(store.addServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mine',
        kind: 'command',
        command: 'npx',
        args: ['-y', 'missing-mcp'],
        scope: 'user',
      }),
    );
  });

  it('"This project only" is chosen in the gallery and carried to the request', async () => {
    const f = open();
    const scope = q<HTMLSelectElement>(f, '[data-testid=gallery-scope]') as HTMLSelectElement;
    scope.value = 'project';
    scope.dispatchEvent(new Event('change'));
    f.detectChanges();
    click(f, '[data-testid=tile-linear]');
    click(f, '[data-testid=server-add]');
    await settle(f);
    expect(store.add).toHaveBeenCalledWith(expect.objectContaining({ id: 'linear', scope: 'project' }));
  });

  it('Back returns to the gallery sliding the other way, and Escape closes', () => {
    const f = open();
    click(f, '[data-testid=tile-custom]');
    click(f, '[data-testid=wizard-back]');
    expect(q(f, '[data-wstep=gallery]')?.classList.contains('back')).toBe(true);
    let closed = 0;
    f.componentInstance.closed.subscribe(() => closed++);
    q(f, '.win')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(1);
    expect(store.closeWizard).toHaveBeenCalled();
  });

  it('opened for a service that needs a token it starts on the details', () => {
    wizard.set({ id: 'github' });
    const g = open();
    expect(q(g, '[data-wstep=details]')).not.toBeNull();
    expect(q(g, '[data-testid=connector-token]')).not.toBeNull();
    expect(q(g, 'h2')?.textContent).toBe('Add a server');
  });

  it('a project-only custom server carries its scope into the form and the request', async () => {
    const f = open();
    const scope = q<HTMLSelectElement>(f, '[data-testid=gallery-scope]') as HTMLSelectElement;
    scope.value = 'project';
    scope.dispatchEvent(new Event('change'));
    f.detectChanges();
    click(f, '[data-testid=tile-custom]');
    expect((q(f, '[data-testid=details-scope]') as HTMLSelectElement).value).toBe('project');
    type(f, '[data-testid=custom-name]', 'local-docs');
    type(f, '[data-testid=custom-url]', 'http://localhost:8080/mcp');
    click(f, '[data-testid=server-add]');
    await settle(f);
    expect(store.addServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'local-docs', scope: 'project' }));
  });
});
