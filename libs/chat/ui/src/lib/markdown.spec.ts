import { TestBed } from '@angular/core/testing';
import { MarkdownService, highlight, languageOf } from './markdown';

describe('MarkdownService', () => {
  const markdown = () => TestBed.inject(MarkdownService);

  it('highlights fenced code with the language it names', () => {
    const html = markdown().render('```ts\nexport const a = 1;\n```');
    expect(html).toContain('<pre><code class="hljs language-ts">');
    expect(html).toContain('hljs-keyword');
  });

  it('leaves a fence of an unknown language as escaped text', () => {
    const html = markdown().render('```nonsense\n<b>x</b>\n```');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('hljs-');
  });

  it('shows raw HTML as text and only links to safe schemes', () => {
    const html = markdown().render('<script>alert(1)</script>\n\n[a](javascript:alert(1)) [b](https://example.com)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="#"');
    expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
  });

  it('renderCached returns the same text for the same input', () => {
    expect(markdown().renderCached('**x**')).toBe(markdown().renderCached('**x**'));
  });

  it('loads uncommon grammars on demand and refreshes cached markdown', async () => {
    const service = markdown();
    const text = '```mathematica\nSin[x] + Cos[y]\n```';
    service.renderCached(text);
    await vi.waitFor(() => expect(service.renderCached(text)).toContain('language-mathematica'));
    expect(highlight('Sin[x]', 'mathematica').html).toContain('hljs-');
  });
});

describe('highlight helpers', () => {
  it('highlight returns the language it used', () => {
    expect(highlight('const a = 1', 'typescript').language).toBe('typescript');
    expect(highlight('<x>', undefined).html).toBe('&lt;x&gt;');
  });

  it('languageOf maps an extension to a highlight.js language', () => {
    expect(languageOf('src/app.ts')).toBe('typescript');
    expect(languageOf('run.sh')).toBe('bash');
    expect(languageOf('Makefile')).toBeUndefined();
    expect(languageOf(undefined)).toBeUndefined();
  });
});
