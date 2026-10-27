import { english } from '@pi-kit/i18n/testing';
import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CONNECTOR_CATALOG, type McpServer } from '@pi-kit/protocol';
import { ChatStore } from '@pi-kit/chat/api';
import { ConnectorsStore, SecretsStore, SettingsStore } from '@pi-kit/settings/api';
import { fileRows, mcpRows } from '@pi-kit/settings/util';
import { McpSection } from './mcp-section';

const server = (over: Partial<McpServer> & { name: string }): McpServer => ({
  scope: 'global',
  source: '/Users/me/.pi/agent/mcp.json',
  transport: 'http',
  target: 'https://mcp.linear.app/mcp',
  exposure: 'deferred',
  enabled: true,
  state: 'connected',
  oauth: true,
  tools: 14,
  ...over,
});

describe('McpSection', () => {
  const servers = signal<McpServer[]>([]);
  const mcp = {
    servers,
    rows: computed(() => mcpRows(english, CONNECTOR_CATALOG, servers())),
    overview: signal<
      { errors: string[]; userConfig: string; projectConfig?: string; projectTrusted: boolean } | undefined
    >({
      errors: [],
      userConfig: '/Users/me/.pi/agent/mcp.json',
      projectConfig: '/proj/.pi/mcp.json',
      projectTrusted: true,
    }),
    loading: signal(false),
    busy: signal(new Set<string>()),
    notice: signal(undefined),
    wizard: signal<{ id?: string } | undefined>(undefined),
    edit: signal<{ name: string; scope: 'user' | 'project' } | undefined>(undefined),
    fileEditor: signal<'user' | 'project' | undefined>(undefined),
    catalog: signal(CONNECTOR_CATALOG),
    threadId: () => 't1' as string | undefined,
    choiceOf: () => ({ scope: 'user' as const }),
    check: vi.fn(),
    add: vi.fn(),
    refresh: vi.fn(async () => undefined),
    loadCatalog: vi.fn(async () => undefined),
    openWizard: vi.fn(),
    openEdit: vi.fn(),
    openFileEditor: vi.fn(),
    closeFileEditor: vi.fn(),
    closeEdit: vi.fn(),
    serverDetail: vi.fn(() => new Promise(() => undefined)),
    file: vi.fn(() => new Promise(() => undefined)),
    login: vi.fn(),
    reconnect: vi.fn(),
    setEnabled: vi.fn(),
    setExposure: vi.fn(),
    disconnect: vi.fn(),
    logout: vi.fn(),
    reload: vi.fn(),
    openFile: vi.fn(),
    cancelSignIn: vi.fn(),
    pasteSignIn: vi.fn(),
    trustFolder: vi.fn(),
    dismissNotice: vi.fn(),
    closeWizard: vi.fn(),
  };
  const settings = { shows: () => true, searching: () => false };

  const render = () => {
    const fixture = TestBed.createComponent(McpSection);
    fixture.detectChanges();
    return fixture;
  };
  const el = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(f: { nativeElement: unknown }, selector: string): T | null =>
    el(f).querySelector<T>(selector);

  beforeEach(() => {
    vi.clearAllMocks();
    servers.set([
      server({ name: 'linear' }),
      server({ name: 'github', target: 'https://api.githubcopilot.com/mcp/', state: 'needs-auth' }),
      server({
        name: 'playwright',
        scope: 'project',
        source: '/proj/.pi/mcp.json',
        transport: 'stdio',
        target: 'npx @playwright/mcp@latest --headless',
        exposure: 'direct',
        oauth: false,
        tools: 21,
      }),
      server({
        name: 'slack',
        target: 'https://mcp.slack.com/mcp',
        enabled: false,
        state: 'disabled',
        tools: undefined,
      }),
    ]);
    mcp.wizard.set(undefined);
    mcp.edit.set(undefined);
    mcp.fileEditor.set(undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ConnectorsStore, useValue: mcp },
        { provide: SettingsStore, useValue: settings },
        { provide: SecretsStore, useValue: { status: signal(undefined), loadStatus: vi.fn(async () => undefined) } },
        { provide: ChatStore, useValue: { running: signal(false) } },
      ],
    });
  });

  it('is one list of every server: catalog services with their names, servers of your own with their command and file', () => {
    const f = render();
    const rows = Array.from(el(f).querySelectorAll('.pk-item'));
    expect(rows.map((r) => r.getAttribute('data-server'))).toEqual(['linear', 'github', 'playwright', 'slack']);
    expect(q(f, '[data-server=linear] .nm')?.textContent).toContain('Linear');
    expect(q(f, '[data-server=playwright] .ds')?.textContent).toBe(
      'npx @playwright/mcp@latest --headless · .pi/mcp.json',
    );
    expect(q(f, '[data-server=slack]')?.classList.contains('off')).toBe(true);
    // no catalog of services that are not connected on the page: that is the wizard's gallery
    expect(q(f, '[data-testid=connector-notion]')).toBeNull();
    expect(el(f).querySelector('pk-connectors-section')).toBeNull();
  });

  it('says the state, the scope and the tool count of each', () => {
    const f = render();
    expect(q(f, '[data-testid=state-linear]')?.textContent).toBe('connected');
    expect(q(f, '[data-testid=state-github]')?.textContent).toBe('needs sign-in');
    expect(q(f, '[data-testid=state-slack]')?.textContent).toBe('off');
    expect(q(f, '[data-server=playwright] .chip.off')?.textContent).toBe('project');
    expect(q(f, '[data-testid=tools-count-playwright]')?.textContent).toBe('21 tools');
  });

  it('puts the one text button a state needs on its row: Sign in, Turn on', () => {
    const f = render();
    q(f, '[data-testid=signin-github]')?.click();
    expect(mcp.login).toHaveBeenCalledWith('github');
    q(f, '[data-testid=turn-on-slack]')?.click();
    expect(mcp.setEnabled).toHaveBeenCalledWith('slack', true);
    expect(q(f, '[data-testid=signin-linear]')).toBeNull();
  });

  it('the Tools select changes how tools reach the model', () => {
    const f = render();
    const select = q(f, '[data-testid=exposure-linear]') as HTMLSelectElement;
    expect(select.value).toBe('deferred');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Direct', 'Codemode', 'Deferred']);
    select.value = 'direct';
    select.dispatchEvent(new Event('change'));
    expect(mcp.setExposure).toHaveBeenCalledWith('linear', 'direct');
  });

  it('Edit opens the details of that server, and More has Reconnect, Turn off, Sign out and Remove', () => {
    const f = render();
    q(f, '[data-testid=edit-linear]')?.click();
    expect(mcp.openEdit).toHaveBeenCalledWith('linear', 'user');
    q(f, '[data-testid=edit-playwright]')?.click();
    expect(mcp.openEdit).toHaveBeenCalledWith('playwright', 'project');
    q(f, '[data-testid=more-linear]')?.click();
    f.detectChanges();
    const items = Array.from(el(f).querySelectorAll('pk-context-menu [role=menuitem]'));
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Reconnect', 'Turn off', 'Sign out', 'Remove']);
    (items[3] as HTMLElement).click();
    f.detectChanges();
    expect(mcp.disconnect).toHaveBeenCalledWith('linear');
    expect(el(f).querySelector('pk-context-menu')).toBeNull();
  });

  it('every icon-only button has a name', () => {
    const f = render();
    for (const b of Array.from(el(f).querySelectorAll<HTMLButtonElement>('button.btn-square')))
      expect(b.getAttribute('aria-label'), b.outerHTML).toBeTruthy();
  });

  it('the "+" opens the wizard; an empty list invites with the same', () => {
    const f = render();
    q(f, '[data-testid=add-server]')?.click();
    expect(mcp.openWizard).toHaveBeenCalled();
    servers.set([]);
    f.detectChanges();
    expect(q(f, '[data-testid=mcp-empty]')?.textContent).toContain('No MCP servers yet');
  });

  it('a sign-in that waits for the browser shows its link on the row, with Copy and Cancel', () => {
    servers.set([
      server({
        name: 'linear',
        state: 'needs-auth',
        signIn: { phase: 'waiting', url: 'https://auth.example/authorize?x=1' },
      }),
    ]);
    const f = render();
    expect(q(f, '[data-testid=signin-panel-linear]')?.textContent).toContain('Waiting for your browser');
    expect(q(f, '[data-testid=signin-url-linear]')?.getAttribute('href')).toBe('https://auth.example/authorize?x=1');
    q(f, '[data-testid=cancel-signin-linear]')?.click();
    expect(mcp.cancelSignIn).toHaveBeenCalledWith('linear');
  });

  it('lists the two files with their servers, Edit here, Open in editor and Reveal', () => {
    const f = render();
    const files = fileRows(mcp.overview() as never, servers());
    expect(files.map((r) => r.scope)).toEqual(['user', 'project']);
    expect(q(f, '[data-testid=file-user]')?.textContent).toContain('/Users/me/.pi/agent/mcp.json');
    expect(q(f, '[data-testid=file-user]')?.textContent).toContain('3 servers');
    expect(q(f, '[data-testid=file-project]')?.textContent).toContain('1 server');
    q(f, '[data-testid=open-user]')?.click();
    expect(mcp.openFile).toHaveBeenCalledWith('user', 'open');
    q(f, '[data-testid=reveal-project]')?.click();
    expect(mcp.openFile).toHaveBeenCalledWith('project', 'reveal');
    expect(q<HTMLButtonElement>(f, '[data-testid=edit-file-user]')?.disabled).toBe(false);
    q(f, '[data-testid=edit-file-user]')?.click();
    expect(mcp.openFileEditor).toHaveBeenCalledWith('user');
    q(f, '[data-testid=edit-file-project]')?.click();
    expect(mcp.openFileEditor).toHaveBeenCalledWith('project');
  });

  it('the edit form and the file editor are lazy parts of the page too', async () => {
    const f = render();
    mcp.edit.set({ name: 'linear', scope: 'user' });
    mcp.fileEditor.set('project');
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(el(f).querySelector('pk-edit-server-dialog')).not.toBeNull();
    expect(el(f).querySelector('pk-file-editor-dialog')).not.toBeNull();
  });

  it('the wizard is a lazy part of the page: it renders when the store says it is open', async () => {
    const f = render();
    mcp.wizard.set({});
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(el(f).querySelector('pk-add-server-wizard')).not.toBeNull();
  });
});
