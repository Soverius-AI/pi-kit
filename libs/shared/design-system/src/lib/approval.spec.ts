import { TestBed } from '@angular/core/testing';
import { Language } from '@pi-kit/i18n';
import { PkApproval } from './approval';

describe('translated approval controls', () => {
  it('updates default labels on an existing view without translating the supplied question', async () => {
    const language = TestBed.inject(Language);
    await language.activate('en');
    const fixture = TestBed.createComponent(PkApproval);
    fixture.componentRef.setInput('question', 'User supplied question?');
    fixture.detectChanges();
    expect(
      [...fixture.nativeElement.querySelectorAll('button')].map((b: HTMLButtonElement) => b.textContent?.trim()),
    ).toEqual(['Deny', 'Allow']);
    await language.activate('de');
    fixture.detectChanges();
    expect(
      [...fixture.nativeElement.querySelectorAll('button')].map((b: HTMLButtonElement) => b.textContent?.trim()),
    ).toEqual(['Ablehnen', 'Zulassen']);
    expect(fixture.nativeElement.textContent).toContain('User supplied question?');
    fixture.componentRef.setInput('allowLabel', 'Run my command');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Run my command');
    await language.activate('en');
  });
});
