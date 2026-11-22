import { TestBed } from '@angular/core/testing';
import { PkDiagnostics } from './diagnostics';

describe('PkDiagnostics', () => {
  it('takes the tone of the worst item, lists every message and reports a dismissal', async () => {
    const fixture = TestBed.createComponent(PkDiagnostics);
    const root = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('title', 'pi reported 2 problems');
    fixture.componentRef.setInput('levelLabels', { info: 'Info', warning: 'Warning', error: 'Error' });
    fixture.componentRef.setInput('dismissLabel', 'Dismiss');
    fixture.componentRef.setInput('items', [{ level: 'warning', message: 'Extension package "a": old' }]);
    await fixture.whenStable();
    expect(root.classList).toContain('alert-warning');
    expect(root.getAttribute('role')).toBe('status');
    fixture.componentRef.setInput('items', [
      { level: 'warning', message: 'Extension package "a": old' },
      { level: 'error', message: 'Failed to load extension "b.ts": boom' },
    ]);
    await fixture.whenStable();
    expect(root.classList).toContain('alert-error');
    expect(root.getAttribute('role')).toBe('alert');
    expect([...root.querySelectorAll('li')].map((li) => li.getAttribute('data-level'))).toEqual(['warning', 'error']);
    expect(root.textContent).toContain('Failed to load extension "b.ts": boom');
    let dismissed = 0;
    fixture.componentInstance.dismissed.subscribe(() => dismissed++);
    (root.querySelector('[data-testid="session-diagnostics-dismiss"]') as HTMLButtonElement).click();
    expect(dismissed).toBe(1);
  });
});
