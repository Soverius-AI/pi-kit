import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  ComposioConnect,
  ComposioConnection,
  ComposioFoundApp,
  ComposioStatus,
  ComposioToolkit,
} from '@pi-kit/protocol';
import { BrandLogosStore, ComposioStore, ConnectorsStore } from '@pi-kit/settings/api';
import { ComposioDialog } from './composio-dialog';

describe('ComposioDialog', () => {
  const sevdesk: ComposioToolkit = {
    slug: 'sevdesk',
    name: 'sevDesk',
    description: 'Accounting',
    logo: null,
    tools: 40,
    noAuth: false,
  };
  const status = signal<ComposioStatus | undefined>(undefined);
  const connections = signal<ComposioConnection[]>([]);
  const connect = signal<ComposioConnect | undefined>(undefined);
  const connectors = { openWizard: vi.fn(), login: vi.fn(async () => true) };
  const store = {
    status,
    connections,
    connect,
    wire: vi.fn(async () => true),
    unwire: vi.fn(async () => undefined),
    connectLink: vi.fn(async () => undefined),
    loadConnect: vi.fn(async () => undefined),
    searchApps: vi.fn(async () => undefined),
    found: signal<{ query: string; apps: ComposioFoundApp[] } | undefined>(undefined),
    searching: signal(false),
    toolkits: signal([sevdesk]),
    loading: signal(false),
    error: signal<string | undefined>(undefined),
    setKey: vi.fn(async () => true),
    add: vi.fn(async () => true),
    link: vi.fn(async () => undefined),
    search: vi.fn(async () => undefined),
    forgetKey: vi.fn(async () => undefined),
    close: vi.fn(),
  };

  const render = () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: ComposioStore, useValue: store },
        { provide: ConnectorsStore, useValue: connectors },
        {
          provide: BrandLogosStore,
          useValue: { logos: signal({ gmail: 'data:image/svg+xml;base64,PHN2Zy8+' }), load: vi.fn() },
        },
      ],
    });
    const fixture = TestBed.createComponent(ComposioDialog);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connections.set([]);
    connect.set(undefined);
  });

  it('lists the apps of the Composio sign-in, offers the rest and connects one on request', () => {
    status.set({ configured: false, storage: null });
    connect.set({
      server: 'composio',
      signedIn: true,
      problem: null,
      apps: [
        { toolkit: 'gmail', name: 'Gmail', connected: true, signInUrl: null, error: null },
        { toolkit: 'notion', name: 'Notion', connected: false, signInUrl: null, error: null },
      ],
    });
    const { el } = render();
    expect(el.querySelector('[data-testid=composio-app-gmail]')?.textContent).toContain('connected');
    expect(el.querySelector('[data-testid=composio-app-gmail] img')?.getAttribute('src')).toContain('data:image/svg');
    expect((el.querySelector('[data-testid=composio-popular-gmail]') as HTMLButtonElement).disabled).toBe(true);
    (el.querySelector('[data-testid=composio-connect-notion]') as HTMLButtonElement).click();
    expect(store.connectLink).toHaveBeenCalledWith('notion');
    (el.querySelector('[data-testid=composio-popular-outlook]') as HTMLButtonElement).click();
    expect(store.wire).toHaveBeenCalledWith('outlook', 'Outlook');
  });

  it('sends the person to add Composio when there is no sign-in server', () => {
    status.set({ configured: false, storage: null });
    connect.set({ server: null, signedIn: false, problem: null, apps: [] });
    const { el } = render();
    (el.querySelector('[data-testid=composio-connect-missing] button') as HTMLButtonElement).click();
    expect(connectors.openWizard).toHaveBeenCalledWith('composio');
  });

  it('asks for the key first, sends it once and empties the field', async () => {
    status.set({ configured: false, storage: null });
    const { el } = render();
    expect(el.querySelector('[data-testid=composio-about]')?.textContent).toContain('Composio’s cloud');
    const input = el.querySelector('[data-testid=composio-key]') as HTMLInputElement;
    input.value = 'secret-key-1';
    (el.querySelector('[data-testid=composio-key-form]') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await Promise.resolve();
    expect(store.setKey).toHaveBeenCalledWith('secret-key-1');
    expect(input.value).toBe('');
  });

  it('adds a chosen app read only unless unticked, and shows the sign-in link an app still needs', () => {
    status.set({ configured: true, storage: 'keychain' });
    connections.set([
      {
        server: 'composio-hubspot',
        toolkit: 'hubspot',
        name: 'HubSpot',
        readOnly: true,
        connected: false,
        signInUrl: 'https://connect.example/hubspot',
      },
    ]);
    const { fixture, el } = render();
    expect(
      (el.querySelector('[data-testid=composio-signin-composio-hubspot]') as HTMLAnchorElement).getAttribute('href'),
    ).toBe('https://connect.example/hubspot');
    (el.querySelector('[data-testid=composio-tile-sevdesk]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect((el.querySelector('[data-testid=composio-read-only]') as HTMLInputElement).checked).toBe(true);
    (el.querySelector('[data-testid=composio-add]') as HTMLButtonElement).click();
    expect(store.add).toHaveBeenCalledWith(sevdesk, true);
    expect((el.querySelector('[data-testid=composio-forget]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('narrows the popular apps as you type and asks Composio for anything else', () => {
    status.set({ configured: false, storage: null });
    connect.set({ server: 'composio', signedIn: true, problem: null, apps: [] });
    const { fixture, el } = render();
    const search = el.querySelector('[data-testid=composio-connect-search]') as HTMLInputElement;
    search.value = 'zen';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(
      [...el.querySelectorAll('[data-testid^=composio-popular-]')].map((tile) => tile.getAttribute('data-testid')),
    ).toEqual(['composio-popular-zendesk']);
    (el.querySelector('[data-testid=composio-search-composio]') as HTMLButtonElement).click();
    expect(store.searchApps).toHaveBeenCalledWith('zen');
  });
});
