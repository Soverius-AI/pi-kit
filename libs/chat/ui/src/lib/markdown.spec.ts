import { TestBed } from '@angular/core/testing';
import { MarkdownService, highlight, languageOf } from './markdown';

describe('MarkdownService', () => {
  const markdown = () => TestBed.inject(MarkdownService);

  it('shows raw HTML as text and only links to safe schemes', () => {
    const { html } = markdown().document(
      '<script>alert(1)</script>\n\n[a](javascript:alert(1)) [b](https://example.com)',
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="#"');
    expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
  });

  it('renders inline and display math without trusting TeX HTML commands', () => {
    const service = markdown();
    expect(service.document('The result is $E = mc^2$.').html).toContain('class="katex"');
    expect(service.document('$$\n\\frac{1}{2}\n$$').html).toContain('katex-display');
    expect(service.document(String.raw`$\href{javascript:alert(1)}{click}$`).html).not.toContain('href="javascript:');
    expect(service.document(String.raw`$\def\x{\x}\x$`).html).toContain('katex-error');
  });

  it('contains deeply nested and oversized math instead of breaking the message', () => {
    const service = markdown();
    const nested = '$' + '{'.repeat(3000) + 'x' + '}'.repeat(3000) + '$';
    expect(service.document(nested).html).toContain('pk-math-error');
    expect(service.document('$' + 'x'.repeat(10001) + '$').html).toContain('pk-math-error');
    expect(
      service.document('$' + '{'.repeat(101) + '<img src=x onerror=alert(1)>' + '}'.repeat(101) + '$').html,
    ).not.toContain('<img');
  });

  it('does not parse dollars in code, escaped dollars, currency, or unfinished math', () => {
    const service = markdown();
    for (const source of ['`$x$`', '```tex\n$x$\n```', String.raw`\$x\$`, '$349 ... $289', '$E = mc', 'Price: $5']) {
      expect(service.document(source).html, source).not.toContain('class="katex"');
    }
  });

  it('keeps nested component slots in their Markdown structure', () => {
    const document = markdown().document(
      '> ```mermaid\n> graph TD\n> A-->B\n> ```\n\n- Example\n\n  ```ts\n  const n = 1;\n  ```',
    );
    expect(document.html).toContain('<blockquote>');
    expect(document.html).toContain('<div data-pk-block="0"></div>');
    expect(document.html).toContain('<li>');
    expect(document.blocks).toEqual([
      { kind: 'mermaid', code: 'graph TD\nA-->B', language: 'mermaid', streaming: false },
      { kind: 'code', code: 'const n = 1;', language: 'ts', streaming: false },
    ]);
  });

  it('repairs streaming prose but preserves exact diagram/code source and real fence completion', () => {
    const service = markdown();
    expect(service.document('An **unfinished answer', true).html).toContain('<strong>unfinished answer</strong>');
    expect(service.document('```mermaid', true).blocks[0].streaming).toBe(true);
    expect(service.document('```mermaid\n', true).blocks[0].streaming).toBe(true);
    const open = service.document('~~~mermaid\ngraph TD\nA[Start]-->B[', true);
    expect(open.blocks[0]).toEqual({
      kind: 'mermaid',
      code: 'graph TD\nA[Start]-->B[',
      language: 'mermaid',
      streaming: true,
    });
    const closed = service.document('~~~mermaid\ngraph TD\nA-->B\n~~~\n\nStill **writing', true);
    expect(closed.blocks[0].streaming).toBe(false);
    expect(service.document('```ts\nconst a = "**["', true).blocks[0].code).toBe('const a = "**["');
  });

  it('repairs only the trailing prose while streaming and keeps reference links', () => {
    const service = markdown();
    const streamed = service.document('use snake_case names\n\n- array[0] value\n\nStill **writing', true).html;
    expect(streamed).toContain('<p>use snake_case names</p>');
    expect(streamed).toContain('<li>array[0] value</li>');
    expect(streamed).toContain('<strong>writing</strong>');
    expect(service.document('[1]: https://example.com\n\nSee [spec][1] **now', true).html).toContain(
      '<a href="https://example.com"',
    );
  });

  it('does not invent Markdown closers for complete TeX and caches only finished documents', () => {
    const service = markdown();
    expect(service.document('$x_{i}$', true).html).not.toContain('</span>_');
    const text = '**finished**';
    expect(service.document(text)).toBe(service.document(text));
    expect(service.document(text, true)).not.toBe(service.document(text, true));
    const first = service.document(text);
    for (let i = 0; i < 401; i++) service.document(`entry ${i}`);
    expect(service.document(text)).not.toBe(first);
  });

  it('loads uncommon grammars on demand', async () => {
    highlight('Sin[x]', 'mathematica');
    await vi.waitFor(() => expect(highlight('Sin[x]', 'mathematica').language).toBe('mathematica'));
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
