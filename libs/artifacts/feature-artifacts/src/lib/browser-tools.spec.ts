import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserStore } from '@pi-kit/artifacts/data';
import { ChatStore } from '@pi-kit/chat/api';
import { ViewPrefs } from '@pi-kit/data-access';
import { emptyBrowserState } from '@pi-kit/protocol';
import { BrowserTools } from './browser-tools';

describe('browser certificate options', () => {
  it('exposes a default-off localhost-only option and persists the explicit choice', async () => {
    const previous = window.piKit;
    window.piKit = {
      getBackendUrl: async () => '',
      getToken: async () => '',
      setBrowserLocalCertificates: vi.fn(async () => undefined),
    };
    const prefs = { browserAllowInvalidLocalCertificates: signal(false), set: vi.fn(async () => true) };
    try {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: BrowserStore,
            useValue: { page: signal(emptyBrowserState('chat', true)), busy: signal(false), threadId: signal('chat') },
          },
          { provide: ViewPrefs, useValue: prefs },
          { provide: ChatStore, useValue: {} },
        ],
      });
      const f = TestBed.createComponent(BrowserTools);
      f.detectChanges();
      const el = f.nativeElement as HTMLElement;
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Options')?.click();
      f.detectChanges();
      const checkbox = el.querySelector<HTMLInputElement>('[data-testid=browser-local-certificates]')!;
      expect(checkbox.checked).toBe(false);
      expect(checkbox.disabled).toBe(false);
      expect(el.textContent).toContain('not remote sites or backend requests');
      expect(prefs.set).not.toHaveBeenCalled();
      checkbox.click();
      await f.whenStable();
      expect(prefs.set).toHaveBeenCalledWith('browserAllowInvalidLocalCertificates', true);
    } finally {
      window.piKit = previous;
    }
  });
});
