import { TestBed } from '@angular/core/testing';
import { instanceIdentity, instanceRename, provideMockApi } from '@pi-kit/api';
import { SettingsStore } from '@pi-kit/settings/data';
import { EnvironmentSection } from './environment-section';

const identity = { instanceId: 'f1a77d38-aa39-45b9-ac63-60a662a9737d', name: 'Work Mac', protocolVersion: 1 as const };

describe('Settings environment name', () => {
  const rename = vi.fn(async (name: string) => ({ ...identity, name }));
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [instanceIdentity, async () => identity, () => []],
          [instanceRename, rename, (request) => [request.body?.['name']]],
        ]),
        { provide: SettingsStore, useValue: { matches: () => new Set(['environment-name']) } },
      ],
    });
  });
  afterEach(() => document.querySelectorAll('meta[name="pi-kit-connection"]').forEach((element) => element.remove()));
  async function render() {
    const fixture = TestBed.createComponent(EnvironmentSection);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelector('[data-testid=environment-error]')?.textContent).toBeFalsy();
      expect(element.querySelector('[data-testid=environment-name]')).not.toBeNull();
    });
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('renames freely without changing the owner identity', async () => {
    const { fixture, element } = await render();
    const input = element.querySelector('[data-testid=environment-name]') as HTMLInputElement;
    expect(input.value).toBe('Work Mac');
    expect((element.querySelector('[data-testid=environment-save]') as HTMLButtonElement).disabled).toBe(true);
    input.value = '  Arbeits-Mac 日本語  ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(rename).toHaveBeenCalledWith('Arbeits-Mac 日本語');
    expect(element.querySelector('[data-testid=environment-identity]')?.textContent).toContain(identity.instanceId);
    expect(input.value).toBe('Arbeits-Mac 日本語');
  });

  it('does not submit empty/control-character names', async () => {
    const { fixture, element } = await render();
    for (const value of [' ', '\u202efake']) {
      const input = element.querySelector('[data-testid=environment-name]') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect((element.querySelector('[data-testid=environment-save]') as HTMLButtonElement).disabled).toBe(true);
    }
    expect(rename).not.toHaveBeenCalled();
  });

  it('shows the connected instance read-only on the phone', async () => {
    const marker = document.createElement('meta');
    marker.name = 'pi-kit-connection';
    marker.content = 'device';
    document.head.append(marker);
    const { element } = await render();
    expect((element.querySelector('[data-testid=environment-name]') as HTMLInputElement).disabled).toBe(true);
    expect(element.querySelector('[data-testid=environment-save]')).toBeNull();
    expect(rename).not.toHaveBeenCalled();
  });
});
