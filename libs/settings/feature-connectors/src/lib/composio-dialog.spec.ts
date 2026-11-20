import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComposioConnection, ComposioStatus, ComposioToolkit } from '@pi-kit/protocol';
import { ComposioStore } from '@pi-kit/settings/api';
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
  const store = {
    status,
    connections,
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
    TestBed.configureTestingModule({ providers: [{ provide: ComposioStore, useValue: store }] });
    const fixture = TestBed.createComponent(ComposioDialog);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connections.set([]);
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
});
