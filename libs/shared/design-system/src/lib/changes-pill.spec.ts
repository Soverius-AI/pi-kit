import { TestBed } from '@angular/core/testing';
import { PkChangesPill } from './changes-pill';

describe('PkChangesPill', () => {
  it('shows the totals, names what they count and is pressed on a click', () => {
    const fixture = TestBed.createComponent(PkChangesPill);
    fixture.componentRef.setInput('added', 128);
    fixture.componentRef.setInput('removed', 23);
    fixture.componentRef.setInput('title', 'Review changes: 4 files, +128 −23, from this thread');
    let pressed = 0;
    fixture.componentInstance.pressed.subscribe(() => (pressed += 1));
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    expect(button.querySelector('.text-success')?.textContent).toBe('+128');
    expect(button.querySelector('.text-error')?.textContent).toBe('−23');
    expect(button.title).toBe('Review changes: 4 files, +128 −23, from this thread');
    expect(button.getAttribute('aria-label')).toBe('Review changes: 4 files, +128 −23, from this thread');
    button.click();
    expect(pressed).toBe(1);
  });
});
