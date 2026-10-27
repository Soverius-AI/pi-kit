import { TestBed } from '@angular/core/testing';
import { ansiSegments, PkAnsiText } from './ansi-text';

const esc = '\u001b';

describe('extension status ANSI rendering', () => {
  it('renders the reported 256-color token speed and resets the following text', () => {
    expect(ansiSegments(`${esc}[38;5;102m87.2 tok/s${esc}[39m ready`)).toEqual([
      { text: '87.2 tok/s', style: { color: 'rgb(135, 135, 135)' } },
      { text: ' ready', style: {} },
    ]);
  });

  it('supports theme colors, grayscale, truecolor and independent resets', () => {
    const segments = ansiSegments(`${esc}[1;2;31;48;2;10;20;30mred${esc}[22;39mplain${esc}[38;5;255mgray${esc}[0mend`);
    expect(segments).toEqual([
      {
        text: 'red',
        style: { color: 'var(--color-error)', backgroundColor: 'rgb(10, 20, 30)', fontWeight: 'bold', opacity: '0.6' },
      },
      { text: 'plain', style: { backgroundColor: 'rgb(10, 20, 30)' } },
      { text: 'gray', style: { color: 'rgb(238, 238, 238)', backgroundColor: 'rgb(10, 20, 30)' } },
      { text: 'end', style: {} },
    ]);
    expect(ansiSegments(`${esc}[38;5;999mignored${esc}[38;2;300;0;0m invalid`)).toEqual([
      { text: 'ignored', style: {} },
      { text: ' invalid', style: {} },
    ]);
  });

  it('discards terminal controls and hyperlink metadata while keeping the label', () => {
    expect(ansiSegments(`${esc}[2K${esc}]8;;https://example.com\u0007label${esc}]8;;${esc}\\\u0007`)).toEqual([
      { text: 'label', style: {} },
    ]);
  });

  it('safely renders both historical raw ANSI and subsequent status updates', async () => {
    const fixture = TestBed.createComponent(PkAnsiText);
    fixture.componentRef.setInput('text', `${esc}[38;5;102m87.2 tok/s${esc}[39m <img src=x onerror=alert(1)>`);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toBe('87.2 tok/s <img src=x onerror=alert(1)>');
    expect(element.querySelector('span')?.style.color).toBe('rgb(135, 135, 135)');
    expect(element.querySelector('img')).toBeNull();
    fixture.componentRef.setInput('text', 'ready');
    await fixture.whenStable();
    expect(element.textContent).toBe('ready');
    expect(element.querySelector('span')?.style.color).toBe('');
  });
});
