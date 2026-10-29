import { TestBed } from '@angular/core/testing';
import { PkDiffTotals } from './diff-totals';

describe('PkDiffTotals', () => {
  it('shows the added and removed lines', () => {
    const fixture = TestBed.createComponent(PkDiffTotals);
    fixture.componentRef.setInput('added', 12);
    fixture.componentRef.setInput('removed', 4);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.text-success')?.textContent).toBe('+12');
    expect(root.querySelector('.text-error')?.textContent).toBe('−4');
  });
});
