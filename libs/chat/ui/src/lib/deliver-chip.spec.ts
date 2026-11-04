import { TestBed } from '@angular/core/testing';
import { DeliverChip } from './deliver-chip';

describe('delivery menu overlay', () => {
  it('opens outside the composer, accepts a choice, and returns focus', async () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(DeliverChip);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const trigger = root.querySelector<HTMLButtonElement>('[data-testid="deliver-chip"]')!;
    const pick = vi.fn();
    fixture.componentInstance.pick.subscribe(pick);
    trigger.click();
    await fixture.whenStable();
    const popup = document.querySelector<HTMLElement>('.pk-composer-overlay [role="dialog"]')!;
    expect(popup).not.toBeNull();
    expect(root.contains(popup)).toBe(false);
    popup.click();
    await fixture.whenStable();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    popup.querySelectorAll<HTMLElement>('[role="option"]')[1].click();
    await fixture.whenStable();
    expect(pick).toHaveBeenCalledExactlyOnceWith('followUp');
    expect(document.querySelector('.pk-composer-overlay')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
