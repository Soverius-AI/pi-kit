import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ThemeStore } from '@pi-kit/data-access';
import { MermaidRenderer } from './mermaid-renderer';
import { Prose } from './prose';

const IMAGE = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"%3E%3C/svg%3E';

describe('Prose', () => {
  let fixture: ComponentFixture<Prose>;
  let render: ReturnType<typeof vi.fn>;
  const root = () => fixture.nativeElement as HTMLElement;
  const update = async (text: string, streaming = false) => {
    fixture.componentRef.setInput('text', text);
    fixture.componentRef.setInput('streaming', streaming);
    await fixture.whenStable();
  };

  beforeEach(() => {
    render = vi.fn().mockResolvedValue(IMAGE);
    TestBed.configureTestingModule({
      providers: [
        { provide: MermaidRenderer, useValue: { render } },
        { provide: ThemeStore, useValue: { isDark: signal(false) } },
      ],
    });
    fixture = TestBed.createComponent(Prose);
  });

  it('preserves sanitized KaTeX layout styles and accessible MathML, including outside assistant messages', async () => {
    await update('Result: $x^2$\n\n$$\n\\frac{1}{2}\n$$');
    expect(root().querySelectorAll('.katex')).toHaveLength(2);
    expect(root().querySelector('math semantics annotation')?.textContent).toBe('x^2');
    expect(root().querySelector('.katex-display [style]')).not.toBeNull();
    expect(root().querySelector('.katex-error')).toBeNull();
  });

  it('escapes model HTML, keeps unsafe links, scripts and styles out of the DOM, and opens safe links externally', async () => {
    await update(
      '<script>alert(1)</script>\n\n<style>body{display:none}</style>\n\n[bad](javascript:alert(1)) [docs](https://example.com)',
    );
    expect(root().querySelector('script, style')).toBeNull();
    expect(root().textContent).toContain('<script>alert(1)</script>');
    const [bad, docs] = Array.from(root().querySelectorAll('a'));
    expect(bad.getAttribute('href')).toBe('#');
    // The desktop shell only opens target=_blank links; plain in-window navigation is cancelled.
    expect(docs.getAttribute('target')).toBe('_blank');
    expect(docs.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('composes real Angular code blocks inside lists and blockquotes', async () => {
    await update('> ```ts\n> const a = "<b>";\n> ```\n\n- Nested\n\n  ```js\n  const b = 2;\n  ```');
    expect(root().querySelector('blockquote pk-code-block')).not.toBeNull();
    expect(root().querySelector('li pk-code-block')).not.toBeNull();
    expect(root().querySelectorAll('pk-code-block button')).toHaveLength(2);
    expect(root().querySelector('code')?.textContent).toBe('const a = "<b>";');
    expect(root().querySelector('code b')).toBeNull();
  });

  it('retains diagram instances as text streams, validates closed fences, and cleans up removed components', async () => {
    await update('```mermaid\ngraph TD\nA-->B\n```\n\nStill **writing', true);
    const diagram = root().querySelector('pk-mermaid');
    expect(diagram).not.toBeNull();
    expect(root().querySelector('img')).not.toBeNull();
    expect(render).toHaveBeenCalledWith('graph TD\nA-->B', false, false);
    await update('```mermaid\ngraph TD\nA-->B\n```\n\nStill **writing more', true);
    expect(root().querySelector('pk-mermaid')).toBe(diagram);
    expect(render).toHaveBeenCalledTimes(1);
    expect(root().querySelector('.pk-caret')).not.toBeNull();
    await update('Just prose now');
    expect(root().querySelector('pk-mermaid')).toBeNull();
    expect(root().querySelector('.pk-caret')).toBeNull();
  });

  it('renders unfinished inline Markdown while preserving the actual source for copy', async () => {
    await update('```text\n[unfinished **\n```\n\n**Hello', true);
    expect(root().querySelector('strong')?.textContent).toBe('Hello');
    expect(root().querySelector('code')?.textContent).toBe('[unfinished **');
  });
});
