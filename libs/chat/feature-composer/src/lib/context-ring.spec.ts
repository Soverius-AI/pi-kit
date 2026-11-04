import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatStore, ChatTree, UsageStore } from '@pi-kit/chat/data';
import { ContextRing } from './context-ring';

describe('context usage overlay', () => {
  it('is outside the composer, keeps inside clicks open, and closes on Escape', async () => {
    TestBed.resetTestingModule();
    const open = signal(false);
    const close = vi.fn(() => open.set(false));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ChatStore,
          useValue: {
            threadId: () => 'fixture',
            running: () => false,
            totalCost: () => 0,
            totalTurns: () => 0,
            meter: () => ({
              level: 'ok',
              percent: 20,
              aria: 'Context',
              text: '20%',
              headline: 'Context window',
              tokens: '20/100',
            }),
          },
        },
        {
          provide: UsageStore,
          useValue: {
            open,
            close,
            toggle: () => open.update((value) => !value),
            models: () => [],
            cacheHit: () => undefined,
            loading: () => false,
          },
        },
        { provide: ChatTree, useValue: { showContext: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(ContextRing);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const trigger = root.querySelector<HTMLButtonElement>('[data-testid="context-meter"]')!;
    trigger.click();
    await fixture.whenStable();
    const popup = document.querySelector<HTMLElement>('[data-testid="usage-popover"]')!;
    expect(popup).not.toBeNull();
    expect(root.contains(popup)).toBe(false);
    popup.click();
    await fixture.whenStable();
    expect(open()).toBe(true);
    popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});
