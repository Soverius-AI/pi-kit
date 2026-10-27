import { english } from '@pi-kit/i18n/testing';
import { TranslocoService } from '@pi-kit/i18n';
import { TestBed } from '@angular/core/testing';
import type { PiDialogAnswer, PiDialogRequest } from '@pi-kit/protocol';
import { ConfirmBlock, EditorBlock, InputBlock, SelectBlock, askedBy } from './interrupt-blocks';

/** The element a selector finds; a missing one fails the test with its selector. */
function find<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`No element matches ${selector}`);
  return found;
}
const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement => {
  const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`No button named ${name}`);
  return found;
};

const key = (target: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('askedBy', () => {
  it('names the extension and the tool when it knows them', () => {
    expect(askedBy(english, { method: 'confirm', title: 'x' })).toBe('Asked by an extension');
    expect(askedBy(english, { method: 'confirm', title: 'x', source: 'git-guard', tool: 'bash' })).toBe(
      'Asked by an extension · git-guard · while running bash',
    );
  });
});

describe('the dialog blocks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
  });
  afterEach(() => vi.useRealTimers());

  function draw<T>(component: new () => T, request: PiDialogRequest, timeout?: string) {
    const answers: PiDialogAnswer[] = [];
    let dismissed = 0;
    const fixture = TestBed.createComponent(component as never) as {
      componentRef: {
        setInput(n: string, v: unknown): void;
        instance: {
          answered: { subscribe(f: (a: PiDialogAnswer) => void): void };
          dismissed: { subscribe(f: () => void): void };
        };
      };
      detectChanges(): void;
      nativeElement: HTMLElement;
    };
    fixture.componentRef.setInput('request', request);
    if (timeout) fixture.componentRef.setInput('timeout', timeout);
    fixture.componentRef.instance.answered.subscribe((a) => answers.push(a));
    fixture.componentRef.instance.dismissed.subscribe(() => dismissed++);
    fixture.detectChanges();
    // The after-render hooks (the block takes the focus) run on the first tick.
    TestBed.tick();
    return { el: fixture.nativeElement, answers, dismissed: () => dismissed, fixture };
  }

  /** A block ignores Enter for 400 ms after it appears. */
  const arm = () => vi.advanceTimersByTime(450);

  it.each([
    ['confirm', ConfirmBlock, 'Enter erlaubt, Esc verweigert'],
    ['select', SelectBlock, '↑ ↓ bewegen, Enter oder eine Zahl wählen, Esc abbrechen'],
    ['input', InputBlock, 'Enter bestätigt, Esc bricht ab'],
    ['editor', EditorBlock, 'Enter bestätigt, Esc bricht ab'],
  ] as const)('updates keyboard guidance in an open %s dialog when language changes', (method, component, hint) => {
    const { fixture, el } = draw<unknown>(component, { method, title: 'Deployment?' });
    const language = TestBed.inject(TranslocoService);
    try {
      language.setActiveLang('de');
      fixture.detectChanges();
      expect(el.textContent).toContain(hint);
      expect(el.textContent).toContain('Deployment?');
    } finally {
      language.setActiveLang('en');
    }
  });

  it('confirm: shows who asked and the timeout, Enter allows and Esc denies, buttons answer too', () => {
    const { el, answers } = draw(
      ConfirmBlock,
      { method: 'confirm', title: 'Publish?', message: 'Tag v2', source: 'pk-hitl' },
      'pi continues without an answer in 0:30',
    );
    expect(el.textContent).toContain('Publish?');
    expect(el.textContent).toContain('Tag v2');
    expect(el.textContent).toContain('Asked by an extension · pk-hitl');
    expect(el.textContent).toContain('pi continues without an answer in 0:30');
    const group = find(el, 'pk-approval');
    key(group, 'Enter');
    expect(answers).toEqual([]);
    arm();
    key(group, 'Enter');
    key(group, 'Escape');
    expect(answers).toEqual([{ confirmed: true }, { confirmed: false }]);
    buttonNamed(el, 'Allow').click();
    expect(answers.at(-1)).toEqual({ confirmed: true });
  });

  it('confirm: Enter on a button leaves the answer to that button', () => {
    const { el, answers } = draw(ConfirmBlock, { method: 'confirm', title: 'Publish?' });
    arm();
    const deny = buttonNamed(el, 'Deny');
    key(deny, 'Enter');
    expect(answers).toEqual([]);
  });

  it('select: lists the options with the first highlighted; arrows, numbers and Esc', () => {
    const { el, answers, dismissed } = draw(SelectBlock, {
      method: 'select',
      title: 'Target',
      options: ['a', 'b', 'c'],
    });
    const options = () => Array.from(el.querySelectorAll<HTMLElement>('[data-option]'));
    expect(options().map((o) => o.dataset['option'])).toEqual(['a', 'b', 'c']);
    expect(options()[0].classList.contains('btn-warning')).toBe(true);
    key(options()[0], 'ArrowDown');
    TestBed.tick();
    expect(options()[1].classList.contains('btn-warning')).toBe(true);
    key(options()[1], 'End');
    TestBed.tick();
    expect(options()[2].classList.contains('btn-warning')).toBe(true);
    key(options()[2], 'ArrowDown');
    TestBed.tick();
    expect(options()[0].classList.contains('btn-warning')).toBe(true);
    key(options()[0], '3');
    expect(answers).toEqual([{ value: 'c' }]);
    options()[1].click();
    expect(answers.at(-1)).toEqual({ value: 'b' });
    key(options()[0], 'Escape');
    expect(dismissed()).toBe(1);
  });

  it('input: an empty answer shows a message and is not sent; a typed one is', () => {
    const { el, answers, dismissed } = draw(InputBlock, { method: 'input', title: 'Name?', placeholder: 'e.g. v1' });
    const field = find<HTMLInputElement>(el, 'input');
    expect(field.placeholder).toBe('e.g. v1');
    find(el, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
    TestBed.tick();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('Type an answer');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(answers).toEqual([]);
    field.value = 'v3';
    field.dispatchEvent(new Event('input'));
    TestBed.tick();
    expect(el.querySelector('[role=alert]')).toBeNull();
    find(el, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(answers).toEqual([{ value: 'v3' }]);
    key(find(el, 'pk-approval'), 'Escape');
    expect(dismissed()).toBe(1);
  });

  it('editor: pre-filled; Enter alone is a newline, the modifier with Enter submits, Esc cancels', () => {
    const { el, answers, dismissed } = draw(EditorBlock, { method: 'editor', title: 'Notes', prefill: '# Notes\n' });
    const area = find<HTMLTextAreaElement>(el, 'textarea');
    expect(area.value).toBe('# Notes\n');
    key(area, 'Enter');
    expect(answers).toEqual([]);
    area.value = '# Notes\n- a';
    key(area, 'Enter', { metaKey: true });
    expect(answers).toEqual([{ value: '# Notes\n- a' }]);
    key(area, 'Escape');
    expect(dismissed()).toBe(1);
  });
});
