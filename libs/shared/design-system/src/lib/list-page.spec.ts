import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PkChoice, PkItem, PkQuota, quotaTone, quotaWidth } from './list-page';

@Component({
  selector: 'pk-list-host',
  imports: [PkItem, PkChoice, PkQuota],
  template: `
    <div pkItem [letters]="letters()" [dimmed]="off()" id="row">
      <ng-container nm>OpenRouter <span class="chip ok">API key</span></ng-container>
      <ng-container ds>key ending in a1b2</ng-container>
      <button act type="button">Edit</button>
      <div extra class="signin">waiting</div>
    </div>
    <button pkChoice letters="R" [recommended]="true" [pressed]="picked()" id="choice">
      <ng-container t>Radius</ng-container><ng-container d>One sign-in</ng-container>
    </button>
    <pk-quota name="5-hour window" [used]="38" resets="14:30" id="quota" />
    <pk-quota name="week" [used]="91" id="hot" />
  `,
})
class Host {
  readonly letters = signal('OR');
  readonly off = signal(false);
  readonly picked = signal(false);
}

describe('list page primitives', () => {
  const make = () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
  };
  const q = (fixture: ReturnType<typeof make>, selector: string): HTMLElement =>
    fixture.nativeElement.querySelector(selector);

  it('pkItem is the row: tile letters, name with chips, detail, actions, and what the row opens', () => {
    const f = make();
    const row = q(f, '#row');
    expect(row.classList.contains('pk-item')).toBe(true);
    expect(row.querySelector('.tile')?.textContent?.trim()).toBe('OR');
    expect(row.querySelector('.tile')?.classList.contains('logo')).toBe(true);
    expect(row.querySelector('.nm')?.textContent).toContain('OpenRouter');
    expect(row.querySelector('.nm .chip')?.textContent).toBe('API key');
    expect(row.querySelector('.ds')?.textContent).toContain('a1b2');
    expect(row.querySelector('.act button')?.textContent).toBe('Edit');
    expect(row.querySelector(':scope > .signin')?.textContent).toBe('waiting');
  });

  it('pkItem is drawn quieter when it is off', () => {
    const f = make();
    f.componentInstance.off.set(true);
    f.detectChanges();
    expect(q(f, '#row').classList.contains('off')).toBe(true);
  });

  it('pkChoice is a button tile; the recommended one is outlined, the picked one is pressed', () => {
    const f = make();
    const choice = q(f, '#choice');
    expect(choice.getAttribute('type')).toBe('button');
    expect(choice.classList.contains('rec')).toBe(true);
    expect(choice.getAttribute('aria-pressed')).toBe('false');
    expect(choice.querySelector('.t')?.textContent).toBe('Radius');
    expect(choice.querySelector('.d')?.textContent).toBe('One sign-in');
    f.componentInstance.picked.set(true);
    f.detectChanges();
    expect(choice.getAttribute('aria-pressed')).toBe('true');
  });

  it('pk-quota is a bar and words; it turns amber when the window is nearly used up', () => {
    const f = make();
    const quota = q(f, '#quota');
    expect(quota.getAttribute('aria-label')).toBe('5-hour window 38 %, resets 14:30');
    expect(quota.querySelector<HTMLElement>('.bar i')?.style.width).toBe('38%');
    expect(quota.querySelector('.bar i')?.classList.contains('warn')).toBe(false);
    const hot = q(f, '#hot');
    expect(hot.getAttribute('aria-label')).toBe('week 91 %');
    expect(hot.querySelector('.bar i')?.classList.contains('warn')).toBe(true);
  });

  it('works out the quota tone and its width', () => {
    expect(quotaTone(79)).toBe('ok');
    expect(quotaTone(80)).toBe('warn');
    expect(quotaWidth(140)).toBe(100);
    expect(quotaWidth(-3)).toBe(0);
    expect(quotaWidth(Number.NaN)).toBe(0);
  });
});
