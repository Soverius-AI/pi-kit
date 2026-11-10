import { TestBed } from '@angular/core/testing';
import { PkNotice } from './notice';

describe('PkNotice', () => {
  it('announces only errors and shows the untranslated detail apart from the text', async () => {
    const fixture = TestBed.createComponent(PkNotice);
    const root = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('text', 'Retrying in 5s');
    await fixture.whenStable();
    expect(root.getAttribute('role')).toBeNull();
    expect(root.classList).toContain('alert-info');
    expect(root.querySelector('[data-testid="notice-detail"]')).toBeNull();
    fixture.componentRef.setInput('tone', 'error');
    fixture.componentRef.setInput('detail', '429 Too Many Requests');
    await fixture.whenStable();
    expect(root.getAttribute('role')).toBe('alert');
    expect(root.classList).toContain('alert-error');
    expect(root.querySelector('[data-testid="notice-detail"]')?.textContent).toBe('429 Too Many Requests');
  });
});
