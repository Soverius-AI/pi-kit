import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { PkTip, TIP_DELAY_MS, TIP_FADE_MS, TIP_POSITIONS, isTouch, tipSide } from './tooltip';

@Component({
  selector: 'pk-tip-host',
  imports: [PkTip],
  template: `<button type="button" id="b" [pkTip]="text()" aria-describedby="other">Go</button>`,
})
class Host {
  readonly text = signal('Sign out');
}

const bubble = (): HTMLElement | null => document.body.querySelector('.pk-tt');

describe('pkTip', () => {
  let fixture: ComponentFixture<Host>;
  let button: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    button = fixture.nativeElement.querySelector('button');
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Time passes and the app renders what changed (a bubble is a component of the application, not of the fixture). */
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
    TestBed.tick();
  };

  const enter = (pointerType = 'mouse'): void => {
    const event = new Event('pointerenter');
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    button.dispatchEvent(event);
  };

  it('waits 400 ms after the pointer enters, then shows the text in the overlay with an arrow', () => {
    enter();
    advance(TIP_DELAY_MS - 1);
    expect(bubble()).toBeNull();
    advance(1);
    expect(bubble()?.textContent).toBe('Sign out');
    expect(bubble()?.querySelector('.arrow')).not.toBeNull();
    expect(bubble()?.getAttribute('role')).toBe('tooltip');
    // rendered in the overlay container on the body, not inside the button's own group
    expect(button.contains(bubble())).toBe(false);
    expect(bubble()?.closest('.cdk-overlay-container')).not.toBeNull();
  });

  it('fades in one frame later', () => {
    enter();
    advance(TIP_DELAY_MS + 20);
    expect(bubble()?.classList.contains('show')).toBe(true);
  });

  it.each([100, 260])('points at the trigger after the rendered bubble moves to x=%i', (left) => {
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(280, 200, 32, 32));
    enter();
    advance(TIP_DELAY_MS);
    const tip = bubble() as HTMLElement;
    expect(tip.textContent).toBe('Sign out');
    vi.spyOn(tip, 'getBoundingClientRect').mockReturnValue(new DOMRect(left, 160, 220, 24));
    // The first frame must measure the text's bubble, not the empty overlay pane.
    advance(20);
    expect(tip.style.getPropertyValue('--pk-tt-ax')).toBe(`${296 - left}px`);
  });

  it('describes the button by the bubble while it is shown, keeping what described it before', () => {
    enter();
    advance(TIP_DELAY_MS);
    const id = bubble()?.id ?? '';
    expect(id).toMatch(/^pk-tt-/);
    expect(button.getAttribute('aria-describedby')).toBe(`other ${id}`);
    button.dispatchEvent(new Event('pointerleave'));
    advance(TIP_FADE_MS);
    expect(button.getAttribute('aria-describedby')).toBe('other');
  });

  it('shows nothing when the pointer leaves before the delay', () => {
    enter();
    advance(200);
    button.dispatchEvent(new Event('pointerleave'));
    advance(1000);
    expect(bubble()).toBeNull();
  });

  it('never shows for a touch pointer', () => {
    enter('touch');
    advance(2000);
    expect(bubble()).toBeNull();
  });

  it('shows on keyboard focus, not on a focus the pointer caused', () => {
    vi.spyOn(button, 'matches').mockReturnValue(false);
    button.dispatchEvent(new Event('focus'));
    advance(1000);
    expect(bubble()).toBeNull();
    vi.spyOn(button, 'matches').mockReturnValue(true);
    button.dispatchEvent(new Event('focus'));
    advance(TIP_DELAY_MS);
    expect(bubble()?.textContent).toBe('Sign out');
    button.dispatchEvent(new Event('blur'));
    advance(TIP_FADE_MS);
    expect(bubble()).toBeNull();
  });

  it('hides on Escape, and only the tooltip sees that Escape', () => {
    enter();
    advance(TIP_DELAY_MS);
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(behind).not.toHaveBeenCalled();
    // a second Escape while the bubble is still fading goes where it was meant to
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(behind).toHaveBeenCalledOnce();
    advance(TIP_FADE_MS);
    expect(bubble()).toBeNull();
    document.removeEventListener('keydown', behind);
    // with nothing shown, Escape goes where it was meant to
    const later = vi.fn();
    document.addEventListener('keydown', later);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(later).toHaveBeenCalledOnce();
    document.removeEventListener('keydown', later);
  });

  it('hides on a click and does not come back until the pointer has left and entered again', () => {
    enter();
    advance(TIP_DELAY_MS);
    button.dispatchEvent(new Event('pointerdown'));
    advance(TIP_FADE_MS);
    expect(bubble()).toBeNull();
  });

  it('shows nothing for an empty text, and follows the text when it changes', () => {
    fixture.componentInstance.text.set('');
    fixture.detectChanges();
    enter();
    advance(2000);
    expect(bubble()).toBeNull();
    fixture.componentInstance.text.set('Edit');
    fixture.detectChanges();
    enter();
    advance(TIP_DELAY_MS);
    expect(bubble()?.textContent).toBe('Edit');
  });

  it('removes the bubble when the button goes away', () => {
    enter();
    advance(TIP_DELAY_MS);
    fixture.destroy();
    expect(bubble()).toBeNull();
  });
});

describe('where the bubble goes', () => {
  it('tries above first, then below, then aligned to an edge', () => {
    expect(TIP_POSITIONS[0]).toMatchObject({ originY: 'top', overlayY: 'bottom', overlayX: 'center' });
    expect(TIP_POSITIONS[1]).toMatchObject({ originY: 'bottom', overlayY: 'top', overlayX: 'center' });
    expect(TIP_POSITIONS.slice(2).map((p) => p.overlayX)).toEqual(['end', 'end', 'start', 'start']);
    expect(TIP_POSITIONS.slice(2).map((p) => p.overlayY)).toEqual(['bottom', 'top', 'bottom', 'top']);
  });

  it('names the side the overlay chose, so the arrow points the right way', () => {
    expect(tipSide(TIP_POSITIONS[0])).toBe('top');
    expect(tipSide(TIP_POSITIONS[1])).toBe('bottom');
    expect(tipSide(TIP_POSITIONS[3])).toBe('bottom');
  });

  it('knows a finger from a mouse', () => {
    expect(isTouch(Object.assign(new Event('pointerenter'), { pointerType: 'touch' }))).toBe(true);
    expect(isTouch(Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }))).toBe(false);
    expect(isTouch(new Event('mouseenter'))).toBe(false);
  });
});
