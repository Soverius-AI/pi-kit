import { TestBed } from '@angular/core/testing';
import { PkToolOutput } from './tool-output';

describe('PkToolOutput', () => {
  it('shows the output tail, the note about what was cut and a caret while live', async () => {
    const fixture = TestBed.createComponent(PkToolOutput);
    const root = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('text', 'line 41\nline 42');
    await fixture.whenStable();
    expect(root.querySelector('.meta')).toBeNull();
    expect(root.querySelector('pre')?.textContent).toBe('line 41\nline 42');
    fixture.componentRef.setInput('note', '… 40 earlier lines not shown');
    fixture.componentRef.setInput('live', true);
    await fixture.whenStable();
    expect(root.querySelector('.meta')?.textContent).toBe('… 40 earlier lines not shown');
    expect(root.querySelector('.animate-pulse')).not.toBeNull();
  });
});
