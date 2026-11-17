import mermaid from 'mermaid';
import { MermaidRenderer } from './mermaid-renderer';

/** Deliberately uses the installed Mermaid implementation, not the renderer suite's module mock.
 * Mermaid image nodes fetch during layout, before our output sanitizer can inspect the SVG.
 */
describe('Mermaid network preflight (real Mermaid)', () => {
  afterEach(() => vi.restoreAllMocks());

  function observeNetwork() {
    // Block an unexpected request as well as recording it: regressions must not contact the network.
    const imageSource = vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(() => {
      throw new Error('Unexpected Mermaid image request');
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected Mermaid fetch'));
    // This is a call-through spy, not a substitute renderer. A rejection must precede live DOM/CSS work,
    // including browser resource loads that do not go through the JavaScript fetch/Image APIs.
    const render = vi.spyOn(mermaid, 'render');
    return { imageSource, fetch, render };
  }

  it('rejects real image-node grammar, including an escaped YAML image key, before any rendering or request', async () => {
    const observed = observeNetwork();
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false });
    const renderer = new MermaidRenderer();
    const sources = [
      'flowchart TD\nA@{ img: "https://attacker.invalid/tracker" }',
      String.raw`flowchart TD
A@{ "im\u0067": "https://attacker.invalid/escaped-key" }`,
      'flowchart TD\nA@{\n img: "http://127.0.0.1:1234/private"\n label: "image"\n}',
    ];
    for (const source of sources) {
      // Establish that these are genuine supported Mermaid inputs, not invalid attack-shaped strings.
      await expect(mermaid.parse(source)).resolves.toEqual(expect.objectContaining({ diagramType: 'flowchart-v2' }));
      await expect(renderer.render(source, false)).rejects.toThrow('image metadata and custom styles');
    }
    expect(observed.render).not.toHaveBeenCalled();
    expect(observed.imageSource).not.toHaveBeenCalled();
    expect(observed.fetch).not.toHaveBeenCalled();
    expect(document.querySelector('[id^="pk-mermaid-"]')).toBeNull();
  });

  it('rejects sequence-diagram properties that can fetch icons without extended node metadata', async () => {
    const observed = observeNetwork();
    const source = String.raw`sequenceDiagram
participant A
properties A: {"ic\u006fn": "https://attacker.invalid/sequence-icon"}
A->>A: hello`;
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    // Sequence diagrams use a separate JSON properties statement, not flowchart's @{...} syntax.
    const actors = (diagram.db as { getActors(): Map<string, { properties: { icon?: string } }> }).getActors();
    expect(actors.get('A')?.properties.icon).toBe('https://attacker.invalid/sequence-icon');
    await expect(new MermaidRenderer().render(source, false)).rejects.toThrow();
    expect(observed.render).not.toHaveBeenCalled();
    expect(observed.imageSource).not.toHaveBeenCalled();
    expect(observed.fetch).not.toHaveBeenCalled();
  });

  it('rejects custom style entry points and network-bearing CSS before real Mermaid can insert live styles', async () => {
    const observed = observeNetwork();
    const renderer = new MermaidRenderer();
    const sources = [
      'flowchart TD\nA-->B\nclassDef default fill:red',
      'flowchart TD\nA-->B; style A fill:red',
      'flowchart TD\nA-->B\nlinkStyle 0 stroke:red',
      'flowchart TD\nA-->B\nclassDef default fill:url(https://attacker.invalid/paint)',
      'flowchart TD\nA-->B\nclassDef default fill:u\\72l(https://attacker.invalid/escaped-css)',
      'flowchart TD\nA["@import https://attacker.invalid/style.css"]',
      'flowchart TD\nA["@font-face { font-family: tracker }"]',
    ];
    // The whole styling feature is intentionally denied, including syntactically valid innocuous styles.
    for (const source of sources.slice(0, 3)) await expect(mermaid.parse(source)).resolves.toBeTruthy();
    for (const source of sources) {
      // The escaped url() is not valid Mermaid, so the parser rejects it first; either way nothing renders.
      const expected = source.includes('\\72l') ? 'Parse error' : 'image metadata and custom styles';
      await expect(renderer.render(source, false)).rejects.toThrow(expected);
    }
    expect(observed.render).not.toHaveBeenCalled();
    expect(observed.imageSource).not.toHaveBeenCalled();
    expect(observed.fetch).not.toHaveBeenCalled();
  });

  it("applies keyword checks by the diagram type Mermaid's parser reports", async () => {
    // Layout is stubbed: this exercises the real parser's type detection, not jsdom geometry.
    const render = vi
      .spyOn(mermaid, 'render')
      .mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>', diagramType: '' });
    const renderer = new MermaidRenderer();
    for (const source of [
      'gantt\n  dateFormat YYYY-MM-DD\n  Style guide :s1, 2027-01-11, 2d\n  Link accounts :l1, after s1, 2d\n  Details page :d1, after l1, 1d',
      'erDiagram\n  DETAILS }|--|| PRODUCT : describes',
      'stateDiagram-v2\n  Details --> Done',
      '%% overview\nflowchart TD\n  links --> properties',
    ]) {
      await expect(renderer.render(source, false), source).resolves.toMatch(/^data:image\/svg\+xml/);
    }
    for (const source of [
      'sequenceDiagram\nparticipant A\nlink A: Help @ https://attacker.invalid',
      '%% menu\nsequenceDiagram\nparticipant A\nlinks A: {"Help": "https://attacker.invalid"}',
      'sequenceDiagram\nparticipant A\ndetails A: {"x": 1}',
      'stateDiagram-v2\n  A --> B\n  style A fill:red',
    ]) {
      await expect(renderer.render(source, false), source).rejects.toThrow('not allowed');
    }
    expect(render).toHaveBeenCalledTimes(4);
  });
});
