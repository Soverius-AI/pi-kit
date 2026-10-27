import { describe, expect, it } from 'vitest';
import { diffTextWidth } from './diff-width';

describe('diff text width', () => {
  it('uses eight-space tab stops for long offscreen lines', () => {
    const measure = (text: string) => text.length * 8;
    expect(diffTextWidth('a\tb', measure, 8)).toBe(72);
    expect(diffTextWidth('12345678\tx', measure, 8)).toBe(136);
    expect(diffTextWidth('a\t\tx', measure, 8)).toBe(136);
  });
});
