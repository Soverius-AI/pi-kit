import { TestBed } from '@angular/core/testing';
import { Language } from '@pi-kit/i18n';
import { PkEnvGlyph, PkEnvLookPicker, type PkEnvLookOption } from './env-look';

const here: PkEnvLookOption = {
  id: 'here',
  name: 'Desk',
  look: { icon: 'neko', color: 2 },
  editable: true,
  online: true,
};
const peer: PkEnvLookOption = {
  id: 'peer',
  name: 'Laptop',
  look: { icon: 'oni', color: 5 },
  editable: false,
  online: true,
};
const away: PkEnvLookOption = {
  id: 'away',
  name: 'Server',
  look: { icon: 'mech', color: 9 },
  editable: false,
  online: false,
};

describe('PkEnvGlyph', () => {
  it('draws the env icon in its identity colour, hidden from assistive tech', () => {
    const fixture = TestBed.createComponent(PkEnvGlyph);
    fixture.componentRef.setInput('look', { icon: 'drone', color: 4 });
    fixture.componentRef.setInput('size', 22);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.getAttribute('data-size')).toBe('22');
    expect(el.style.getPropertyValue('--pk-env-color')).toBe('var(--pk-identity-4)');
    expect(el.querySelector<HTMLElement>('.pk-icon')?.style.getPropertyValue('--icon')).toBe(
      'var(--pk-icon-env-drone)',
    );
  });
});

describe('PkEnvLookPicker', () => {
  beforeEach(async () => await TestBed.inject(Language).activate('en'));

  const render = (environments: PkEnvLookOption[]) => {
    const fixture = TestBed.createComponent(PkEnvLookPicker);
    fixture.componentRef.setInput('environments', environments);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const click = (testid: string) => {
      el.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();
      fixture.detectChanges();
    };
    const saved: unknown[] = [];
    fixture.componentInstance.saved.subscribe((value) => saved.push(value));
    return { fixture, el, click, saved };
  };

  it('picks an icon and a colour, previews them and saves this computer’s look', () => {
    const { el, click, saved } = render([here, peer]);
    const save = () => el.querySelector<HTMLButtonElement>('[data-testid="env-look-save"]')!;
    expect(save().disabled).toBe(true);
    expect(el.querySelector('[data-testid="env-look-icon-neko"]')?.getAttribute('aria-checked')).toBe('true');
    click('env-look-icon-katana');
    click('env-look-color-8');
    expect(el.querySelector('[data-testid="env-look-icon-katana"]')?.getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector('.preview pk-env-glyph')?.getAttribute('data-icon')).toBe('katana');
    click('env-look-save');
    expect(saved).toEqual([{ id: 'here', look: { icon: 'katana', color: 8 } }]);
  });

  it('warns when another environment already uses the icon and colour, without blocking', () => {
    const { el, click } = render([here, peer]);
    click('env-look-icon-oni');
    click('env-look-color-5');
    expect(el.querySelector('[data-testid="env-look-duplicate"]')?.textContent).toContain('Laptop already uses');
    expect(el.querySelector<HTMLButtonElement>('[data-testid="env-look-save"]')!.disabled).toBe(false);
  });

  it('shows a paired environment’s own look read-only, and disables one that is offline', () => {
    const { el, click } = render([here, peer, away]);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="env-look-tab-away"]')!.disabled).toBe(true);
    click('env-look-tab-peer');
    expect(el.querySelector('[data-testid="env-look-icon-oni"]')?.getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector('[data-testid="env-look-elsewhere"]')?.textContent).toContain('Laptop');
    expect(el.querySelector<HTMLButtonElement>('[data-testid="env-look-save"]')!.disabled).toBe(true);
  });

  it('moves the choice with the arrow keys', () => {
    const { el, fixture } = render([here]);
    el.querySelector('[data-testid="env-look-icon-neko"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight' }),
    );
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="env-look-icon-drone"]')?.getAttribute('aria-checked')).toBe('true');
  });
});
