import { describe, expect, it } from 'vitest';
import { PreviewOrigins } from './preview-policy';

describe('trusted preview policy', () => {
  it('defaults closed and canonicalizes exact origins', () => {
    expect(PreviewOrigins.configured(undefined, {})).toEqual([]);
    expect(
      PreviewOrigins.configured(undefined, {
        PI_KIT_PREVIEW_ORIGINS: 'https://preview.example:443,http://localhost:8100',
      }),
    ).toEqual(['https://preview.example', 'http://localhost:8100']);
  });
  it.each([
    'https:',
    '*',
    'https://*.example.com',
    'https://ok.example;frame-src',
    'https://ok.example/a',
    'https://u:p@ok.example',
    'https://ok.example?q=x',
    'https://ok.example/#hash',
    'https://ok.example; frame-src *',
    'https://ok.example,',
  ])('rejects invalid entire configuration: %s', (value) => {
    expect(() => PreviewOrigins.configured(undefined, { PI_KIT_PREVIEW_ORIGINS: value })).toThrow();
  });
  it('blocks own and backend origins and phone cookie hostname across ports', () => {
    const configured = PreviewOrigins.configured([
      'https://phone.example',
      'https://phone.example:9000',
      'http://127.0.0.1:4300',
      'https://preview.example',
    ]);
    expect(
      PreviewOrigins.permitted(configured, ['https://phone.example'], 'http://127.0.0.1:4300', 'phone.example'),
    ).toEqual(['https://preview.example']);
    expect(PreviewOrigins.permitted(['http://localhost:9000'], ['http://localhost:8000'])).toEqual([
      'http://localhost:9000',
    ]);
  });
  it('escapes bootstrap JSON attribute', () => {
    expect(PreviewOrigins.meta(['https://preview.example'])).toBe(
      '<meta name="pi-kit-preview-origins" content="[&quot;https://preview.example&quot;]">',
    );
    expect(PreviewOrigins.meta(['"<>&\''])).not.toContain('<>&');
  });
});
