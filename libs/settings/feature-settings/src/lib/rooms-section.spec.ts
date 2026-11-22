import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiClient, EntryApiClient, a2aCard, instanceSetLook, provideMockApi, roomsHosts } from '@pi-kit/api';
import { ViewPrefs } from '@pi-kit/data-access';
import { A2aAgentsStore, SettingsStore } from '@pi-kit/settings/data';
import { RoomsSection } from './rooms-section';

const HERE = 'f1a77d38-aa39-45b9-ac63-60a662a9737d';
const PEER = '0b6a1f9e-3c2d-4e5f-8a7b-9c0d1e2f3a4b';

describe('Settings rooms', () => {
  const setLook = vi.fn(async (look: unknown) => look);
  const forOwner = vi.fn();
  const setPref = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [
            roomsHosts,
            async () => [
              {
                environmentId: HERE,
                name: 'Work Mac',
                local: true,
                ready: true,
                reason: null,
                look: { icon: 'oni', color: 2 },
              },
              {
                environmentId: PEER,
                name: 'Linux box',
                local: false,
                ready: true,
                reason: null,
                look: { icon: 'runner', color: 1 },
              },
            ],
            () => [],
          ],
          [
            a2aCard,
            async () => ({
              version: '0.93.0',
              supportedInterfaces: [
                { url: 'https://peer/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
              ],
              capabilities: { streaming: true, pushNotifications: true, extensions: [{ uri: 'urn:pi-kit:room-task' }] },
              skills: [{ id: 'room-task', name: 'Room task' }],
            }),
            () => [],
          ],
          [instanceSetLook, setLook, (request) => [request.body]],
        ]),
        {
          provide: EntryApiClient,
          useFactory: () => {
            const client = TestBed.inject(ApiClient).client;
            forOwner.mockReturnValue(client);
            return { client, forOwner };
          },
        },
        {
          provide: SettingsStore,
          useValue: { shows: () => true, matches: () => new Set(['rooms-preview', 'rooms-sandbox']), setPref },
        },
        { provide: ViewPrefs, useValue: { roomsPreview: signal(true), roomsSandbox: signal(false) } },
        {
          provide: A2aAgentsStore,
          useValue: { agents: signal([]), busy: signal(false), error: signal(undefined), load: vi.fn(), add: vi.fn() },
        },
      ],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(RoomsSection);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector(`[data-testid=rooms-card-${PEER}]`)).not.toBeNull();
    });
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('shows each machine with its A2A card and keeps the room sandbox off until switched on', async () => {
    const { element } = await render();
    const card = element.querySelector(`[data-testid=rooms-card-${PEER}]`)?.textContent ?? '';
    expect(card).toContain('https://peer/api/a2a');
    expect(card).toContain('Room task');
    const sandbox = element.querySelector('[data-testid=rooms-sandbox]') as HTMLInputElement;
    expect(sandbox.checked).toBe(false);
    sandbox.click();
    expect(setPref).toHaveBeenCalledWith('roomsSandbox', true);
  });

  it('saves a paired machine’s icon on that machine', async () => {
    const { fixture, element } = await render();
    forOwner.mockClear();
    (element.querySelector(`[data-testid=rooms-machine-look-${PEER}]`) as HTMLButtonElement).click();
    fixture.detectChanges();
    (element.querySelector('[data-testid=env-look-icon-katana]') as HTMLButtonElement).click();
    fixture.detectChanges();
    (element.querySelector('[data-testid=env-look-save]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('[data-testid=env-look-picker]')).toBeNull();
    });
    expect(setLook).toHaveBeenCalledWith({ icon: 'katana', color: 1 });
    expect(forOwner).toHaveBeenCalledExactlyOnceWith(PEER);
    expect(
      element.querySelector(`[data-testid=rooms-machine-look-${PEER}] pk-env-glyph`)?.getAttribute('data-icon'),
    ).toBe('katana');
  });
});
