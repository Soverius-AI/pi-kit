import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PkCodeEditor } from './code-editor';

@Component({
  imports: [PkCodeEditor],
  template: `<pk-code-editor
    [(value)]="text"
    [language]="language()"
    [errorLine]="error()"
    [readonly]="locked()"
    (saveRequested)="saves = saves + 1"
  />`,
})
class Host {
  readonly text = signal('{\n  "a": 1,\n  "b": "x"\n}');
  readonly language = signal<'json' | 'markdown' | 'text'>('json');
  readonly error = signal<number | undefined>(undefined);
  readonly locked = signal(false);
  saves = 0;
}

describe('PkCodeEditor', () => {
  const setup = () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const field = el.querySelector('textarea') as HTMLTextAreaElement;
    return { fixture, el, field, host: fixture.componentInstance };
  };

  it('draws a line number and a coloured row for every line, over a textarea with the same text', () => {
    const { el, field } = setup();
    expect(Array.from(el.querySelectorAll('.ln span')).map((s) => s.textContent)).toEqual(['1', '2', '3', '4']);
    expect(el.querySelectorAll('.hl .row')).toHaveLength(4);
    expect(Array.from(el.querySelectorAll('.hl .k')).map((k) => k.textContent)).toEqual(['"a"', '"b"']);
    expect(el.querySelector('.hl .n')?.textContent).toBe('1');
    expect(el.querySelector('.hl .s')?.textContent).toBe('"x"');
    expect(field.value).toBe('{\n  "a": 1,\n  "b": "x"\n}');
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(field.getAttribute('wrap')).toBe('off');
  });

  it('typing updates the model and the colours', () => {
    const { fixture, el, field, host } = setup();
    field.value = '{\n  "c": true\n}';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.text()).toBe('{\n  "c": true\n}');
    expect(el.querySelectorAll('.ln span')).toHaveLength(3);
    expect(el.querySelector('.hl .l')?.textContent).toBe('true');
  });

  it('marks the line with the error in the gutter and the text, and flags the field invalid', () => {
    const { fixture, el, field, host } = setup();
    host.error.set(3);
    fixture.detectChanges();
    expect(el.querySelector('.ln span.err')?.textContent).toBe('3');
    expect(Array.from(el.querySelectorAll('.hl .row')).findIndex((r) => r.classList.contains('err-line'))).toBe(2);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    host.error.set(undefined);
    fixture.detectChanges();
    expect(el.querySelector('.ln span.err')).toBeNull();
    expect(field.hasAttribute('aria-invalid')).toBe(false);
  });

  it('⌘S and Ctrl+S ask the host to save, and the browser is not asked to save the page', () => {
    const { field, host } = setup();
    const mac = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(mac);
    expect(mac.defaultPrevented).toBe(true);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, bubbles: true, cancelable: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }));
    expect(host.saves).toBe(2);
  });

  it('Enter keeps the indentation, and goes one level in after an opening brace', () => {
    const { fixture, field, host } = setup();
    field.value = '{\n  "a": {';
    field.dispatchEvent(new Event('input'));
    field.setSelectionRange(field.value.length, field.value.length);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(host.text()).toBe('{\n  "a": {\n    ');
    field.value = '  keep';
    field.dispatchEvent(new Event('input'));
    field.setSelectionRange(field.value.length, field.value.length);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(field.value).toBe('  keep\n  ');
  });

  it('Enter between a pair of braces opens a block and leaves the closing brace on its own line', () => {
    const { field } = setup();
    field.value = '  {}';
    field.dispatchEvent(new Event('input'));
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(field.value).toBe('  {\n    \n  }');
    expect(field.selectionStart).toBe(8);
  });

  it('a read-only editor does not indent and does not accept text', () => {
    const { fixture, field, host } = setup();
    host.locked.set(true);
    fixture.detectChanges();
    expect(field.readOnly).toBe(true);
    const before = field.value;
    field.setSelectionRange(1, 1);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(field.value).toBe(before);
  });

  it('colours Markdown for a skill file', () => {
    const { fixture, el, host } = setup();
    host.language.set('markdown');
    host.text.set('---\nname: x\ndescription: Use when y\n---\n\n# Title\n\n1. Run `pnpm test`');
    fixture.detectChanges();
    expect(el.querySelector('.hl .k')?.textContent).toBe('name');
    expect(el.querySelector('.hl .h')?.textContent).toBe('Title');
    expect(el.querySelector('.hl .c')?.textContent).toBe('`pnpm test`');
  });
});
