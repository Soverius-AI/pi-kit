import { TestBed } from '@angular/core/testing';
import { PkAvatar } from './avatar';

describe('PkAvatar', () => {
  const render = (name: string, kind: 'person' | 'agent' = 'agent', label?: string) => {
    const fixture = TestBed.createComponent(PkAvatar);
    fixture.componentRef.setInput('name', name);
    fixture.componentRef.setInput('kind', kind);
    if (label) fixture.componentRef.setInput('label', label);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('shows the machine’s letter without the pi-kit prefix, a stable colour, and an agent badge', () => {
    const el = render('pi-kit B', 'agent', 'Worker on pi-kit B');
    expect(el.querySelector('.letter')?.textContent).toBe('B');
    expect(el.getAttribute('data-hue')).toBe(PkAvatar.hueOf('pi-kit B'));
    expect(el.getAttribute('aria-label')).toBe('Worker on pi-kit B');
    expect(el.querySelector('.pk-avatar-badge')).not.toBeNull();
  });

  it('draws a person without the agent badge, and the same name always gets the same colour', () => {
    const el = render('You', 'person');
    expect(el.querySelector('.pk-avatar-badge')).toBeNull();
    expect(PkAvatar.hueOf('Desktop')).toBe(PkAvatar.hueOf(' desktop '));
  });
});
