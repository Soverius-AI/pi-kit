import { describe, expect, it } from 'vitest';
import { PreviewRegistrationSchema, PreviewUrlSchema, previewOrigins } from './preview';
import { parsePiCustomEvent } from './custom-events';

describe('preview metadata', () => {
  it('accepts set/clear without implying a successful load', () => {
    expect(
      parsePiCustomEvent({
        name: 'pi.preview',
        value: {
          op: 'set',
          sourceUrl: 'http://localhost:4200',
          previewUrl: 'https://preview.example',
          title: 'My app',
        },
      })?.name,
    ).toBe('pi.preview');
    expect(PreviewRegistrationSchema.parse({ op: 'clear' })).toEqual({ op: 'clear' });
  });
  it.each([
    'javascript:alert(1)',
    'file:///tmp/test',
    'data:text/html,hello',
    '//example.com',
    'https://user:secret@example.com',
    '',
  ])('rejects invalid or credential-bearing URL %s', (url) => {
    expect(PreviewUrlSchema.safeParse(url).success).toBe(false);
  });
  it('normalizes and deduplicates trusted exact origins', () => {
    expect(previewOrigins(['https://EXAMPLE.com:443', 'https://example.com/', 'http://localhost:4200'])).toEqual([
      'https://example.com',
      'http://localhost:4200',
    ]);
  });
  it.each([
    'https:',
    '*',
    'https://*.example.com',
    'https://example.com/app',
    'https://user@example.com',
    'https://example.com/?key=x',
    'https://example.com/#x',
  ])('rejects non-origin configuration %s', (origin) => {
    expect(() => previewOrigins([origin])).toThrow();
  });
});
