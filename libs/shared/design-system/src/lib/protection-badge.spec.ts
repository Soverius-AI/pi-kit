import { TestBed } from '@angular/core/testing';
import { PkProtectionBadge } from './protection-badge';

describe('PkProtectionBadge', () => {
  it('shows an open lock for Bypass and a closed lock with a warning dot for unhealthy Sandboxed', async () => {
    const fixture = TestBed.createComponent(PkProtectionBadge);
    const root = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('mode', 'bypass');
    await fixture.whenStable();
    expect(root.querySelector('pk-icon')?.getAttribute('style')).toContain('--pk-icon-lock-open');
    expect(root.querySelector('.bg-warning')).toBeNull();
    expect(root.getAttribute('aria-hidden')).toBe('true');
    fixture.componentRef.setInput('mode', 'sandboxed');
    await fixture.whenStable();
    expect(root.querySelector('pk-icon')?.classList).not.toContain('active');
    fixture.componentRef.setInput('active', true);
    await fixture.whenStable();
    expect(root.querySelector('pk-icon')?.classList).toContain('active');
    fixture.componentRef.setInput('attention', true);
    fixture.componentRef.setInput('label', 'Sandbox unavailable');
    await fixture.whenStable();
    expect(root.querySelector('pk-icon')?.getAttribute('style')).toContain('--pk-icon-lock)');
    expect(root.querySelector('pk-icon')?.classList).toContain('text-warning');
    expect(root.querySelector('pk-icon')?.classList).not.toContain('active');
    expect(root.querySelector('.bg-warning')).not.toBeNull();
    expect(root.getAttribute('role')).toBe('img');
    expect(root.getAttribute('aria-label')).toBe('Sandbox unavailable');
    fixture.componentRef.setInput('busy', true);
    await fixture.whenStable();
    expect(root.querySelector('pk-icon')).toBeNull();
    expect(root.querySelector('.loading-spinner')).not.toBeNull();
  });
});
