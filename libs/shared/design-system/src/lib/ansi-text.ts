import { NgStyle } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: string;
  opacity?: string;
  fontStyle?: string;
  textDecoration?: string;
}
interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const PALETTE = [
  '--pk-sunken',
  '--color-error',
  '--color-success',
  '--color-warning',
  '--color-info',
  '--color-primary',
  '--color-info',
  '--color-neutral-content',
  '--pk-muted',
  '--color-error',
  '--color-success',
  '--color-warning',
  '--color-info',
  '--color-primary',
  '--color-info',
  '--color-neutral-content',
];
const CUBE = [0, 95, 135, 175, 215, 255];

function indexedColor(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return `var(${PALETTE[index]})`;
  if (index >= 232)
    return `rgb(${Array(3)
      .fill(8 + (index - 232) * 10)
      .join(', ')})`;
  const value = index - 16;
  return `rgb(${CUBE[Math.floor(value / 36)]}, ${CUBE[Math.floor(value / 6) % 6]}, ${CUBE[value % 6]})`;
}

/** Only SGR styling becomes CSS; terminal commands and OSC metadata are discarded. Text stays Angular-escaped. */
export function ansiSegments(value: string): AnsiSegment[] {
  const result: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let cursor = 0;
  const append = (text: string) => {
    // Preserve tabs/newlines, but never leave terminal controls in the rendered text.
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (clean) result.push({ text: clean, style: { ...style } });
  };
  // CSI commands, OSC strings (BEL or ST terminated), and two-byte escape sequences.
  // eslint-disable-next-line no-control-regex
  for (const match of value.matchAll(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-_])/g)) {
    append(value.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    // eslint-disable-next-line no-control-regex
    if (!/^\u001b\[[\d;]*m$/.test(match[0])) continue;
    const codes = match[0].slice(2, -1).split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) style = {};
      else if (code === 1) style.fontWeight = 'bold';
      else if (code === 2) style.opacity = '0.6';
      else if (code === 22) {
        delete style.fontWeight;
        delete style.opacity;
      } else if (code === 3 || code === 23) style.fontStyle = code === 3 ? 'italic' : undefined;
      else if (code === 4 || code === 24) style.textDecoration = code === 4 ? 'underline' : undefined;
      else if (code === 39) delete style.color;
      else if (code === 49) delete style.backgroundColor;
      else if (code >= 30 && code <= 37) style.color = indexedColor(code - 30);
      else if (code >= 90 && code <= 97) style.color = indexedColor(code - 90 + 8);
      else if (code >= 40 && code <= 47) style.backgroundColor = indexedColor(code - 40);
      else if (code >= 100 && code <= 107) style.backgroundColor = indexedColor(code - 100 + 8);
      else if (code === 38 || code === 48) {
        const target = code === 38 ? 'color' : 'backgroundColor';
        const mode = codes[++i];
        if (mode === 5) {
          const color = indexedColor(codes[++i]);
          if (color) style[target] = color;
        } else if (mode === 2) {
          const rgb = codes.slice(i + 1, i + 4);
          i += 3;
          if (rgb.length === 3 && rgb.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
            style[target] = `rgb(${rgb.join(', ')})`;
        }
      }
    }
  }
  append(value.slice(cursor));
  return result;
}

/**
 * A line of terminal-style text as styled spans: `ansiSegments` turns its ANSI SGR codes into colours, weights and
 * underlines. The status bar and the composer's status row show pi's status entries with it.
 */
@Component({
  selector: 'pk-ansi-text',
  imports: [NgStyle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `@for (segment of segments(); track $index) {
    <span [ngStyle]="segment.style">{{ segment.text }}</span>
  }`,
})
export class PkAnsiText {
  readonly text = input.required<string>();
  protected readonly segments = computed(() => ansiSegments(this.text()));
}
