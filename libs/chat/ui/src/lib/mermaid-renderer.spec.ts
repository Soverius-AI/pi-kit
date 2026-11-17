import { MermaidRenderer, MERMAID_MAX_EDGES, MERMAID_MAX_TEXT_SIZE } from './mermaid-renderer';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), parse: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

function svg(content = '<text>safe</text>') {
  return `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`;
}
function decode(image: string) {
  return decodeURIComponent(image.split(',')[1]);
}

describe('MermaidRenderer', () => {
  beforeEach(() => {
    mermaid.initialize.mockReset();
    mermaid.parse.mockReset().mockResolvedValue({ diagramType: 'flowchart-v2', config: {} });
    mermaid.render.mockReset().mockResolvedValue({ svg: svg() });
  });

  it('uses strict limits, disables HTML labels, and caches by source and theme', async () => {
    const renderer = new MermaidRenderer();
    await renderer.render('graph TD; A-->B', false);
    await renderer.render('graph TD; A-->B', false);
    await renderer.render('graph TD; A-->B', true);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        htmlLabels: false,
        suppressErrorRendering: true,
        maxEdges: MERMAID_MAX_EDGES,
        maxTextSize: MERMAID_MAX_TEXT_SIZE,
        theme: 'dark',
      }),
    );
    expect(mermaid.render.mock.calls[0][0]).not.toBe(mermaid.render.mock.calls[1][0]);
  });

  it('rejects oversized sources, directives, frontmatter, and interactions before rendering', async () => {
    const renderer = new MermaidRenderer();
    for (const source of [
      'x'.repeat(MERMAID_MAX_TEXT_SIZE + 1),
      '%%{init: {}}%%\ngraph TD',
      '\n---\nconfig: {}\n---\ngraph TD',
      'graph TD\nclick A callback',
      'graph TD; click A callback',
      'graph TD\nclick\nA callback',
      '%% comment\n---\nconfig: {}\n---\ngraph TD',
    ]) {
      await expect(renderer.render(source, false)).rejects.toThrow();
    }
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('applies the keyword and url() policy by diagram type without rejecting ordinary text', async () => {
    const cases: [source: string, diagramType: string, allowed: boolean][] = [
      ['sequenceDiagram\nA->>B: new URL(input)', 'sequence', true],
      ['graph TD\nA["Fetch URL (primary)"]', 'flowchart-v2', true],
      ['mindmap\n  root\n    Style guide', 'mindmap', true],
      ['journey\nsection Docs\nStyle review: 5: Me', 'journey', true],
      ['graph TD\nA["url(https://evil.test/x)"]', 'flowchart-v2', false],
      ['sequenceDiagram\nrect url(//evil.test/x)\nend', 'sequence', false],
      ['graph TD\nA-->B\nstyle A fill:#f00', 'flowchart-v2', false],
      ['classDiagram\nclass A\nlink A "https://evil.test/x"', 'classDiagram', false],
      ['classDiagram\nclass A\ncallback A "fn"', 'class', false],
    ];
    for (const [source, diagramType, allowed] of cases) {
      mermaid.parse.mockResolvedValue({ diagramType, config: {} });
      const result = new MermaidRenderer().render(source, false);
      if (allowed) await expect(result, source).resolves.toMatch(/^data:image\/svg\+xml/);
      else await expect(result, source).rejects.toThrow('not allowed');
    }
    expect(mermaid.render).toHaveBeenCalledTimes(4);
  });

  it("rejects configuration reported by Mermaid's parser before rendering", async () => {
    mermaid.parse.mockResolvedValue({ diagramType: 'flowchart-v2', config: { theme: 'forest' } });
    await expect(new MermaidRenderer().render('graph TD; A-->B', false)).rejects.toThrow('directives and frontmatter');
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('sanitizes with an isolated purifier and returns an SVG image, never inline markup', async () => {
    mermaid.render.mockResolvedValue({
      svg: svg(
        '<script>alert(1)</script><foreignObject><div>HTML</div></foreignObject><image href="https://evil.test/x"/><text onclick="alert(1)">ok</text><use href="https://evil.test/x"/>',
      ),
    });
    const image = await new MermaidRenderer().render('graph TD', false);
    expect(image).toMatch(/^data:image\/svg\+xml/);
    const clean = decode(image);
    expect(clean).toContain('ok');
    expect(clean).not.toMatch(/script|foreignObject|onclick|evil\.test|<image/i);
  });

  it('fails closed if the environment cannot securely sanitize SVG', async () => {
    vi.stubGlobal('DOMParser', undefined);
    try {
      await expect(new MermaidRenderer().render('graph TD', false)).rejects.toThrow('sanitization is unavailable');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects network-bearing styles', async () => {
    mermaid.render.mockResolvedValue({ svg: svg('<style>.x{fill:url(https://evil.test/x)}</style>') });
    await expect(new MermaidRenderer().render('graph TD', false)).rejects.toThrow('External');
  });

  it('serializes initialization and rendering across service instances, including failures', async () => {
    let finish!: (value: { svg: string }) => void;
    mermaid.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = new MermaidRenderer().render('graph TD; A', false);
    const second = new MermaidRenderer().render('graph TD; B', true);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    finish({ svg: svg() });
    await Promise.all([first, second]);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently used cache entries', async () => {
    const renderer = new MermaidRenderer();
    for (let i = 0; i < 33; i++) await renderer.render(`graph TD; A${i}`, false);
    await renderer.render('graph TD; A0', false);
    expect(mermaid.render).toHaveBeenCalledTimes(34);
  });

  it('keeps streaming previews out of the LRU and promotes the final preview without rerendering', async () => {
    const renderer = new MermaidRenderer();
    for (let i = 0; i < 32; i++) await renderer.render(`graph TD; A${i}`, false);
    for (let i = 0; i < 40; i++) await renderer.render(`graph TD; B-->C${i}`, false, true);
    await renderer.render('graph TD; B-->C39', false);
    expect(mermaid.render).toHaveBeenCalledTimes(72);
    await renderer.render('graph TD; A1', false);
    expect(mermaid.render).toHaveBeenCalledTimes(72);
  });
});
