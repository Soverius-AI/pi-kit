import { describe, expect, it } from 'vitest';
import { toolImages } from './tool-images';

describe('toolImages', () => {
  it('retains inline screenshots with a default MIME type', () => {
    expect(
      toolImages([
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'AAAA' },
      ]),
    ).toEqual([{ data: 'AAAA', mimeType: 'image/png' }]);
  });
  it('ignores malformed or unsupported images', () => {
    expect(toolImages([null, { type: 'image' }, { type: 'image', data: 'x', mimeType: 'text/html' }])).toEqual([]);
    expect(toolImages('text')).toEqual([]);
  });
});
