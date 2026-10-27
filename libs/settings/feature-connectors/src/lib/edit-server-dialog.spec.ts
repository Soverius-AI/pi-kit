import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { McpServerDetail } from '@pi-kit/protocol';
import { ConnectorsStore, SecretsStore } from '@pi-kit/settings/api';
import { EditServerDialog } from './edit-server-dialog';

const detail = (over: Partial<McpServerDetail> = {}): McpServerDetail => ({
  name: 'docs',
  scope: 'user',
  path: '/Users/me/.pi/agent/mcp.json',
  kind: 'url',
  url: 'https://docs.example/mcp',
  command: '',
  args: [],
  headers: [
    { key: 'X-Team', value: 'core' },
    { key: 'Authorization', stored: true },
  ],
  env: [],
  exposure: 'deferred',
  description: 'Docs',
  enabled: true,
  kept: ['oauth', 'timeout'],
  oauth: false,
  ...over,
});

describe('EditServerDialog', () => {
  const edit = signal<{ name: string; scope: 'user' | 'project' } | undefined>({ name: 'docs', scope: 'user' });
  const store = {
    edit,
    busy: signal(new Set<string>()),
    notice: signal<{ level: 'info' | 'error'; text: string; trust?: boolean; server?: string } | undefined>(undefined),
    serverDetail: vi.fn(async (): Promise<McpServerDetail> => detail()),
    saveServer: vi.fn(async () => true),
    disconnect: vi.fn(async () => true),
    closeEdit: vi.fn(() => edit.set(undefined)),
    trustFolder: vi.fn(),
  };
  const secrets = {
    status: signal({ available: true, label: 'macOS Keychain' }),
    loadStatus: vi.fn(async () => undefined),
  };

  const open = async () => {
    const fixture = TestBed.createComponent(EditServerDialog);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
    return fixture;
  };
  const root = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(f: { nativeElement: unknown }, selector: string): T | null =>
    root(f).querySelector<T>(selector);
  const type = (f: Awaited<ReturnType<typeof open>>, selector: string, value: string): void => {
    const input = q<HTMLInputElement>(f, selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    f.detectChanges();
  };
  const click = (f: Awaited<ReturnType<typeof open>>, selector: string): void => {
    q(f, selector)?.click();
    f.detectChanges();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    secrets.status.set({ available: true, label: 'macOS Keychain' });
    edit.set({ name: 'docs', scope: 'user' });
    store.busy.set(new Set());
    store.notice.set(undefined);
    store.serverDetail.mockImplementation(async () => detail());
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ConnectorsStore, useValue: store },
        { provide: SecretsStore, useValue: secrets },
      ],
    });
  });

  it('labels a marked secret honestly when protected storage is disabled, but retains stored resolver labels', async () => {
    secrets.status.set({ available: false, label: 'none' });
    const f = await open();
    const plain = q<HTMLButtonElement>(f, '[data-testid=headers-lock-0]')!;
    expect(plain.getAttribute('aria-label')).toContain('plain text in your private user file');
    expect(plain.getAttribute('aria-label')).not.toContain('keychain');
    click(f, '[data-testid=headers-lock-0]');
    expect(plain.getAttribute('aria-pressed')).toBe('true');
    expect(plain.getAttribute('aria-label')).not.toContain('keychain');
    const stored = q<HTMLButtonElement>(f, '[data-testid=headers-lock-1]')!;
    expect(stored.disabled).toBe(true);
    expect(stored.getAttribute('aria-label')).toContain('keychain');
  });

  it('opens with the form prefilled from the file: name, URL, headers, tools, description, scope fixed', async () => {
    const f = await open();
    expect(store.serverDetail).toHaveBeenCalledWith('docs', 'user');
    expect(q(f, 'h2')?.textContent).toBe('docs');
    expect(q(f, '.head .chip')?.textContent).toBe('user');
    expect(q(f, '.head .mono')?.textContent).toBe('/Users/me/.pi/agent/mcp.json');
    expect(q<HTMLInputElement>(f, '[data-testid=custom-name]')?.value).toBe('docs');
    expect(q<HTMLInputElement>(f, '[data-testid=custom-url]')?.value).toBe('https://docs.example/mcp');
    expect(q<HTMLSelectElement>(f, '[data-testid=details-exposure]')?.value).toBe('deferred');
    expect(q<HTMLInputElement>(f, '[data-testid=custom-description]')?.value).toBe('Docs');
    expect(q<HTMLSelectElement>(f, '[data-testid=details-scope]')?.disabled).toBe(true);
    expect(q<HTMLInputElement>(f, '[data-testid=details-enabled]')?.checked).toBe(true);
    expect(q<HTMLInputElement>(f, '[data-testid=headers-key-0]')?.value).toBe('X-Team');
    expect(q<HTMLInputElement>(f, '[data-testid=headers-value-0]')?.value).toBe('core');
    expect(q(f, '[data-testid=kept-keys]')?.textContent).toContain('oauth, timeout');
  });

  it('a stored secret shows as stored, its value is nowhere, and the file keeps it unless something is typed over it', async () => {
    const f = await open();
    const stored = q<HTMLInputElement>(f, '[data-testid=headers-value-1]') as HTMLInputElement;
    expect(stored.type).toBe('password');
    expect(stored.value).toBe('');
    expect(stored.placeholder).toContain('Stored in your keychain');
    expect((q(f, '[data-testid=headers-lock-1]') as HTMLButtonElement).disabled).toBe(true);
    click(f, '[data-testid=server-save]');
    await f.whenStable();
    expect(store.saveServer).toHaveBeenCalledWith('docs', 'user', {
      name: 'docs',
      kind: 'url',
      url: 'https://docs.example/mcp',
      headers: [{ key: 'X-Team', value: 'core' }, { key: 'Authorization' }],
      exposure: 'deferred',
      description: 'Docs',
      enabled: true,
    });
  });

  it('typing over a stored secret sends the new value once, with the mark, and the page never shows it', async () => {
    const f = await open();
    type(f, '[data-testid=headers-value-1]', 'Bearer replaced-token-abcdefghijkl');
    expect(root(f).innerHTML).not.toContain('replaced-token-abcdefghijkl');
    expect(q(f, '[data-testid=as-written-text]')?.textContent).toContain(
      '"Authorization": "!pi-kit-secret get mcp-docs-header-Authorization"',
    );
    click(f, '[data-testid=server-save]');
    await f.whenStable();
    expect(store.saveServer).toHaveBeenCalledWith(
      'docs',
      'user',
      expect.objectContaining({
        headers: [
          { key: 'X-Team', value: 'core' },
          { key: 'Authorization', value: 'Bearer replaced-token-abcdefghijkl', secret: true },
        ],
      }),
    );
  });

  it('a rename is part of the body; a bad name or address stops before anything is sent', async () => {
    const f = await open();
    type(f, '[data-testid=custom-name]', 'renamed');
    click(f, '[data-testid=server-save]');
    await f.whenStable();
    expect(store.saveServer).toHaveBeenCalledWith('docs', 'user', expect.objectContaining({ name: 'renamed' }));
    store.saveServer.mockClear();
    type(f, '[data-testid=custom-url]', 'http://example.com/mcp');
    click(f, '[data-testid=server-save]');
    expect(q(f, '[data-testid=server-error]')?.textContent).toMatch(/https:\/\//);
    expect(store.saveServer).not.toHaveBeenCalled();
  });

  it('rows can be added, locked and removed; a locked value is a secret whatever its name', async () => {
    const f = await open();
    click(f, '[data-testid=headers-remove-0]');
    expect(q(f, '[data-testid=headers-key-0]')?.getAttribute('aria-label')).toBe('Header 1 name');
    expect((q(f, '[data-testid=headers-key-0]') as HTMLInputElement).value).toBe('Authorization');
    click(f, '[data-testid=headers-add]');
    type(f, '[data-testid=headers-key-1]', 'X-Team');
    type(f, '[data-testid=headers-value-1]', 'core-team');
    expect((q(f, '[data-testid=headers-value-1]') as HTMLInputElement).type).toBe('text');
    click(f, '[data-testid=headers-lock-1]');
    expect((q(f, '[data-testid=headers-value-1]') as HTMLInputElement).type).toBe('password');
    expect(q(f, '[data-testid=headers-lock-1]')?.getAttribute('aria-pressed')).toBe('true');
    click(f, '[data-testid=server-save]');
    await f.whenStable();
    expect(store.saveServer).toHaveBeenCalledWith(
      'docs',
      'user',
      expect.objectContaining({
        headers: [{ key: 'Authorization' }, { key: 'X-Team', value: 'core-team', secret: true }],
      }),
    );
  });

  it('a literal secret that is in the file is a password field, not text, and is sent on to the keychain on save', async () => {
    store.serverDetail.mockImplementation(async () =>
      detail({ headers: [{ key: 'Authorization', value: 'Bearer literal-in-the-file-abcdefgh' }] }),
    );
    const f = await open();
    const field = q<HTMLInputElement>(f, '[data-testid=headers-value-0]') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(root(f).innerHTML).not.toContain('literal-in-the-file-abcdefgh');
    click(f, '[data-testid=server-save]');
    await f.whenStable();
    expect(store.saveServer).toHaveBeenCalledWith(
      'docs',
      'user',
      expect.objectContaining({
        headers: [{ key: 'Authorization', value: 'Bearer literal-in-the-file-abcdefgh', secret: true }],
      }),
    );
  });

  it('a command server shows command, arguments and environment', async () => {
    store.serverDetail.mockImplementation(async () =>
      detail({
        kind: 'command',
        url: '',
        command: 'npx',
        args: ['@playwright/mcp@latest', '--headless'],
        headers: [],
        env: [{ key: 'PLAYWRIGHT_BROWSERS_PATH', value: '~/.cache/ms-playwright' }],
        exposure: 'direct',
        enabled: false,
      }),
    );
    const f = await open();
    expect(q<HTMLInputElement>(f, '[data-testid=custom-command]')?.value).toBe('npx');
    expect(q<HTMLInputElement>(f, '[data-testid=custom-args]')?.value).toBe('@playwright/mcp@latest --headless');
    expect(q<HTMLInputElement>(f, '[data-testid=env-key-0]')?.value).toBe('PLAYWRIGHT_BROWSERS_PATH');
    expect(q<HTMLInputElement>(f, '[data-testid=details-enabled]')?.checked).toBe(false);
    expect(q(f, '[data-testid=as-written-text]')?.textContent).toContain('"args": [');
  });

  it('Remove server… asks first, and removes only on the second click', async () => {
    const f = await open();
    click(f, '[data-testid=remove-server]');
    expect(q(f, '[data-testid=remove-confirm]')?.textContent).toContain('Remove docs?');
    expect(store.disconnect).not.toHaveBeenCalled();
    click(f, '[data-testid=remove-cancel]');
    expect(q(f, '[data-testid=remove-confirm]')).toBeNull();
    click(f, '[data-testid=remove-server]');
    click(f, '[data-testid=remove-confirm-yes]');
    await f.whenStable();
    expect(store.disconnect).toHaveBeenCalledWith('docs');
    expect(store.closeEdit).toHaveBeenCalled();
  });

  it('says why when the server cannot be read, and closes with Escape', async () => {
    store.serverDetail.mockRejectedValueOnce(new Error('No MCP server "docs" is in the user’s mcp.json.'));
    const f = await open();
    expect(q(f, '[data-testid=edit-load-error]')?.textContent).toContain('No MCP server');
    expect((q(f, '[data-testid=server-save]') as HTMLButtonElement).disabled).toBe(true);
    let closed = 0;
    f.componentInstance.closed.subscribe(() => closed++);
    q(f, '.win')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(1);
    expect(store.closeEdit).toHaveBeenCalled();
  });

  it('a save that fails stays open and shows pi-kit’s message, with the button to trust the folder when that is the reason', async () => {
    store.saveServer.mockImplementationOnce(async () => {
      store.notice.set({ level: 'error', text: 'This folder is not trusted yet.', trust: true, server: 'docs' });
      return false;
    });
    const f = await open();
    click(f, '[data-testid=server-save]');
    await f.whenStable();
    f.detectChanges();
    expect(q(f, '[data-testid=server-notice]')?.textContent).toContain('not trusted');
    expect(q(f, '[data-testid=trust-folder]')).not.toBeNull();
    expect(store.closeEdit).not.toHaveBeenCalled();
  });
});
