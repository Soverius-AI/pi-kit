import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { PkViewportMenu } from './viewport-menu';

@Component({
  imports: [PkViewportMenu],
  template: `<details pkViewportMenu class="dropdown dropdown-end">
    <summary>More</summary>
    <ul class="dropdown-content">
      <li><button (click)="choose($event)">Open</button></li>
    </ul>
  </details>`,
})
class Host {
  choices = 0;
  choose(event: Event): void {
    event.stopPropagation();
    this.choices++;
  }
}

describe('viewport menu', () => {
  let fixture: ComponentFixture<Host>;
  let details: HTMLDetailsElement;
  let summary: HTMLElement;
  let menu: HTMLElement;
  let show: ReturnType<typeof vi.fn<() => void>>;
  let hide: ReturnType<typeof vi.fn<() => void>>;
  const disconnect = vi.fn();

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {
          /* layout is provided by the test */
        }
        disconnect = disconnect;
      },
    );
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    details = fixture.nativeElement.querySelector('details');
    summary = details.querySelector('summary') as HTMLElement;
    menu = details.querySelector('ul') as HTMLElement;
    show = vi.fn();
    hide = vi.fn();
    menu.showPopover = show;
    menu.hidePopover = hide;
    vi.spyOn(summary, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 100, 24, 24));
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 180));
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const open = (): void => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  };

  it('uses the top layer and keeps an end-aligned menu inside the left edge', () => {
    const focus = vi.spyOn(menu.querySelector('button') as HTMLButtonElement, 'focus');
    open();
    expect(show).toHaveBeenCalledOnce();
    expect(menu.getAttribute('popover')).toBe('manual');
    expect(menu.style.left).toBe('8px');
    expect(menu.style.top).toBe('128px');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('flips above a trigger near the bottom and repositions on resize', () => {
    vi.spyOn(summary, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(window.innerWidth - 30, window.innerHeight - 30, 24, 24),
    );
    open();
    expect(Number.parseFloat(menu.style.left)).toBe(window.innerWidth - 248);
    expect(Number.parseFloat(menu.style.top)).toBe(window.innerHeight - 214);
    vi.spyOn(summary, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 100, 24, 24));
    window.dispatchEvent(new Event('resize'));
    expect(menu.style.left).toBe('8px');
    expect(menu.style.top).toBe('128px');
  });

  it('closes on Escape and returns focus to the trigger', () => {
    open();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(details.open).toBe(false);
    expect(hide).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(summary);
  });

  it('closes after an action even when the handler stops propagation', async () => {
    open();
    (menu.querySelector('button') as HTMLButtonElement).click();
    expect(fixture.componentInstance.choices).toBe(1);
    await Promise.resolve();
    expect(details.open).toBe(false);
    expect(menu.hasAttribute('popover')).toBe(false);
  });

  it('keeps inside clicks open and closes on an outside pointer', () => {
    open();
    menu.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(details.open).toBe(true);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(details.open).toBe(false);
  });
});
