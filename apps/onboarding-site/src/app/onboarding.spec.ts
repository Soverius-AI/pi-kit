import { TestBed } from '@angular/core/testing';
import { provideTransloco, type Translation, type TranslocoLoader } from '@jsverse/transloco';
import { Injectable } from '@angular/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { RemoteAddress } from './addresses';
import { Onboarding } from './onboarding';

@Injectable()
class StubLoader implements TranslocoLoader {
  getTranslation(lang: string) {
    return of<Translation>({
      remoteSite: {
        title: lang === 'de' ? 'Titel' : 'Title',
        openInvalid: 'Invalid',
        'dl.mac': 'macOS',
        'dl.windows': 'Windows',
        'dl.linux': 'Linux',
      },
    });
  }
}

describe('addresses', () => {
  it('accepts only private tailnet origins', () => {
    expect(RemoteAddress.origin('https://my-mac.tail1234.ts.net:8443/')).toBe('https://my-mac.tail1234.ts.net:8443');
    expect(RemoteAddress.origin('https://my-mac.tail1234.ts.net:443')).toBe('https://my-mac.tail1234.ts.net');
    expect(RemoteAddress.origin('http://my-mac.tail1234.ts.net')).toBeUndefined();
    expect(RemoteAddress.origin('https://example.com')).toBeUndefined();
    expect(RemoteAddress.origin('https://user:pw@my-mac.tail1234.ts.net')).toBeUndefined();
  });

  it('follows only a pairing link of a private instance', () => {
    expect(RemoteAddress.pairingLink('https://my-mac.tail1234.ts.net:8443/phone#ABCDEFGHJKLM')).toBe(
      'https://my-mac.tail1234.ts.net:8443/phone#ABCDEFGHJKLM',
    );
    expect(RemoteAddress.pairingLink('https://my-mac.tail1234.ts.net:8443/phone?x=1#ABCDEFGHJKLM')).toBeUndefined();
    expect(RemoteAddress.pairingLink('https://my-mac.tail1234.ts.net:8443/#ABCDEFGHJKLM')).toBeUndefined();
    expect(RemoteAddress.pairingLink('https://evil.example/phone#ABCDEFGHJKLM')).toBeUndefined();
  });
});

describe('Onboarding', () => {
  it('renders the steps and rejects a public address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    TestBed.configureTestingModule({
      providers: [
        provideTransloco({
          config: { availableLangs: ['en', 'de'], defaultLang: 'en', prodMode: true },
          loader: StubLoader,
        }),
      ],
    });
    const fixture = TestBed.createComponent(Onboarding);
    await fixture.whenStable();
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelectorAll('.steps > li')).toHaveLength(5);
    const input = root.querySelector<HTMLInputElement>('[data-testid="address"]')!;
    input.value = 'http://example.com';
    input.dispatchEvent(new Event('input'));
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(root.querySelector('.error')?.textContent).toContain('Invalid');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
