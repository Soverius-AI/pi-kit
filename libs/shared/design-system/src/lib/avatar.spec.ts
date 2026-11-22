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

  it('shows the machine’s look as the corner badge and the participant’s role on top', () => {
    const fixture = TestBed.createComponent(PkAvatar);
    fixture.componentRef.setInput('name', 'pi-kit B');
    fixture.componentRef.setInput('look', { icon: 'skull', color: 3 });
    fixture.componentRef.setInput('participant', 'consultant');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.pk-avatar-badge.look')?.getAttribute('data-icon')).toBe('skull');
    expect(el.getAttribute('data-role')).toBe('consultant');
    expect(el.querySelector<HTMLElement>('.pk-avatar-role .pk-icon')?.style.getPropertyValue('--icon')).toBe(
      'var(--pk-icon-comment)',
    );
  });
});
