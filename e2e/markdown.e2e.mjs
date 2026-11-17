// Deterministic rich Markdown regression: fake local model, no inference or private history.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { api, ensureBackend, env, openApp } from './support/app.mjs';
import { FAKE_MODEL, FAKE_PROVIDER, registerFakeModel, startFakeModel, userTextOf } from './support/fake-model.mjs';

const code = 'const answer = "<safe>";';
const diagram = 'flowchart LR\nUser[User] --> Chat[Chat]\nChat --> Agent[Agent]\nAgent --> Tools[Tools]';
const rich = `# Rich Markdown\n\nInline $E=mc^2$.\n\n$$\n\\frac{1}{2}+\\frac{1}{2}=1\n$$\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\n\`\`\`ts\n${code}\n\`\`\`\n\n<script>window.__markdownUnsafe=true</script>`;
const growing =
  'flowchart TD\n' + Array.from({ length: 45 }, (_, i) => `N${i}[Step ${i}] --> N${i + 1}[Step ${i + 1}]`).join('\n');
const skill = readFileSync(new URL('../apps/backend/src/assets/skills/pi-ui/SKILL.md', import.meta.url), 'utf8');
const examples = [...skill.matchAll(/^```mermaid\r?\n[\s\S]*?^```/gm)].map((match) => match[0]);
let app;
let fake;
let stopBackend;

before(
  async () => {
    fake = await startFakeModel({
      answer: (body) => {
        const prompt = userTextOf(body);
        if (prompt.includes('invalid diagram')) return { text: '```mermaid\nflowchart TD\nA[\n```', chunkMs: 400 };
        if (prompt.includes('supported diagram types')) return { text: examples.join('\n\n'), chunkMs: 100 };
        if (prompt.includes('stream diagram'))
          return { text: `\`\`\`mermaid\n${growing}\n\`\`\`\n\nDone.`, chunkMs: 180 };
        return { text: rich, chunkMs: 100 };
      },
    });
    registerFakeModel(env.agentDir, fake.url);
    stopBackend = await ensureBackend();
    app = await openApp({ clipboard: true });
    // Production builds do not fetch the dev token. This is only the scratch world's token.
    await app.page.evaluate((token) => localStorage.setItem('pi-kit.token', token), env.server.PI_KIT_TOKEN);
    await app.page.reload();
    await app.h.newThread();
    const threads = await api('/api/threads');
    const thread = threads.toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
    await api(`/api/threads/${thread.id}/model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: FAKE_PROVIDER, modelId: FAKE_MODEL, thinkingLevel: 'off' }),
    });
    await app.page.reload();
    await app.page.getByTestId('model-chip').waitFor();
  },
  { timeout: 30_000 },
);
after(async () => {
  await app?.close();
  await fake?.stop();
  await stopBackend?.();
});

it('renders math and Mermaid, copies source, changes theme, and survives cold hydration under a strict CSP', async () => {
  const { page, h } = app;
  await h.prompt('Show rich Markdown.');
  // Constrain the rendered content without changing the development transport's schema compilation.
  // The production browser run also serves this policy as an HTTP header from initial load.
  await page.evaluate((backend) => {
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${backend}; object-src 'none'; base-uri 'self'`;
    document.head.append(policy);
  }, env.api);
  const prose = page.locator('pk-transcript pk-prose').last();
  await prose.locator('pk-mermaid img').waitFor();
  assert.equal(await prose.locator('.katex').count(), 2);
  assert.equal(await prose.locator('.katex-error').count(), 0);
  assert.equal(await prose.locator('math semantics annotation').first().textContent(), 'E=mc^2');
  assert.equal(await page.evaluate(() => window.__markdownUnsafe), undefined);
  const image = prose.locator('pk-mermaid img');
  assert.ok(await image.evaluate((img) => img.complete && img.naturalWidth > 0), 'valid, visible SVG image under CSP');
  await prose.locator('pk-code-block').getByRole('button', { name: 'Copy code', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code);
  const chart = prose.locator('pk-mermaid');
  await chart.getByRole('button', { name: 'Source', exact: true }).click();
  await chart.getByRole('button', { name: 'Copy code', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), diagram);
  await chart.getByRole('button', { name: 'Diagram', exact: true }).click();
  const original = await image.getAttribute('src');
  // Updating persisted theme then cold-reloading exercises the theme store, not just a CSS attribute.
  const nextTheme = await page.evaluate(() =>
    document.documentElement.getAttribute('data-scheme') === 'light' ? 'pi-dark' : 'pi-light',
  );
  const savedTheme = await fetch(`${env.api}/api/settings/theme`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.server.PI_KIT_TOKEN}` },
    body: JSON.stringify({ value: nextTheme }),
  });
  assert.ok(savedTheme.ok);
  await page.evaluate((theme) => localStorage.setItem('pi-kit.theme', theme), nextTheme);
  await page.reload();
  await page.locator('pk-transcript pk-mermaid img').waitFor();
  const hydrated = page.locator('pk-transcript pk-mermaid img').last();
  assert.ok(await hydrated.evaluate((img) => img.complete && img.naturalWidth > 0));
  assert.ok((await hydrated.getAttribute('src')) !== original, 'diagram colors follow the changed app theme');
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

it('opens a fit-to-window viewer and downloads real SVG/PNG snapshots', async () => {
  const { page } = app;
  const chart = page.locator('pk-transcript pk-mermaid').last();
  const trigger = chart.getByRole('button', { name: 'Fullscreen', exact: true });
  await trigger.click();
  const viewer = page.getByRole('dialog', { name: 'Fullscreen Mermaid diagram' });
  await viewer.waitFor();
  const box = await viewer.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(
    Math.abs(box.width - viewport.width) < 2 && Math.abs(box.height - viewport.height) < 2,
    'viewer fills the available window',
  );
  assert.ok(await viewer.locator('img').evaluate((image) => image.complete && image.naturalWidth > 0));
  await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.pk-diagram-fullscreen-image')?.style.width === '125%');
  await viewer.getByRole('button', { name: 'Fit diagram to window', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.pk-diagram-fullscreen-image')?.style.width === '100%');

  const svgDownload = page.waitForEvent('download');
  await viewer.getByRole('button', { name: 'Download SVG', exact: true }).click();
  const svg = await svgDownload;
  assert.equal(svg.suggestedFilename(), 'diagram.svg');
  const svgText = readFileSync(await svg.path(), 'utf8');
  assert.match(svgText, /^<svg\b/);
  assert.ok(svgText.includes('User') && svgText.includes('Tools'));
  assert.ok(!/<script|foreignObject|onclick/i.test(svgText));

  const pngDownload = page.waitForEvent('download');
  await viewer.getByRole('button', { name: 'Download PNG', exact: true }).click();
  const png = await pngDownload;
  assert.equal(png.suggestedFilename(), 'diagram.png');
  const bytes = readFileSync(await png.path());
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(
    bytes.readUInt32BE(16) > 600 && bytes.readUInt32BE(16) <= 8192,
    'PNG uses crisp viewBox resolution, not the default 300px image width',
  );
  assert.ok(bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 8192);
  const alpha = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[3];
  }, bytes.toString('base64'));
  assert.equal(alpha, 255, 'PNG flattens the captured theme background');
  await page.setViewportSize({ width: 390, height: 640 });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('.pk-diagram-dialog');
    return Math.abs(dialog?.getBoundingClientRect().height - innerHeight) < 2;
  });
  assert.ok(
    await viewer.getByRole('button', { name: 'Close', exact: true }).isVisible(),
    'fullscreen controls remain reachable on a narrow screen',
  );
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  await page.setViewportSize(viewport);
  assert.ok(
    await trigger.evaluate((element) => document.activeElement === element),
    'closing restores focus to the diagram',
  );
  await trigger.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await viewer.waitFor({ state: 'detached' });
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

it('renders the actual agent skill examples for flowcharts, sequence diagrams, class diagrams and Gantt charts', async () => {
  assert.ok(examples.length >= 5, 'all documented diagram examples are exercised');
  await app.h.prompt('Show supported diagram types.');
  await app.page.waitForFunction((count) => {
    const prose = [...document.querySelectorAll('pk-transcript pk-prose')].at(-1);
    const images = [...(prose?.querySelectorAll('pk-mermaid img') ?? [])];
    return images.length === count && images.every((image) => image.complete && image.naturalWidth > 0);
  }, examples.length);
  assert.equal(await app.page.locator('pk-transcript pk-prose').last().locator('[role="alert"]').count(), 0);
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

it('shows a valid partial diagram before the fence closes and preserves the component as tokens arrive', async () => {
  const { page, h } = app;
  await h.startPrompt('Please stream diagram.');
  const chart = page
    .locator('pk-transcript pk-mermaid')
    .filter({ has: page.locator('img[src*="flowchart-N0-"]') })
    .last();
  await chart.locator('img').waitFor();
  assert.ok(await h.stopButton.isVisible(), 'the chart appears while the response is still streaming');
  await chart.evaluate((element) => element.setAttribute('data-retained', 'yes'));
  const initial = await chart.locator('img').getAttribute('src');
  const size = await chart.locator('.pk-diagram-preview').evaluate((preview) => {
    const scroller = preview.closest('[cdkscrollable]');
    return { preview: preview.getBoundingClientRect().height, visible: scroller.clientHeight };
  });
  assert.ok(size.preview < size.visible * 0.65, 'a tall inline graph does not stretch beyond the visible chat budget');
  await chart.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Fullscreen Mermaid diagram' });
  await viewer.waitFor();
  await page.waitForFunction((source) => {
    const diagrams = document.querySelectorAll('pk-transcript pk-mermaid img');
    return diagrams[diagrams.length - 1]?.getAttribute('src') !== source;
  }, initial);
  assert.equal(await chart.getAttribute('data-retained'), 'yes');
  assert.ok(await viewer.isVisible(), 'streaming DOM moves do not dismiss fullscreen');
  // The dialog correctly hides background controls from accessibility. Include them when waiting
  // for the real stream to finish, rather than mistaking aria-hidden for a detached Stop button.
  await page
    .locator('pk-composer-toolbar')
    .first()
    .getByRole('button', { name: 'Stop', exact: true, includeHidden: true })
    .waitFor({ state: 'detached' });
  await page.waitForFunction(
    () =>
      document.querySelector('.pk-diagram-snapshot') ||
      document.querySelector('.pk-diagram-fullscreen-image img')?.getAttribute('src')?.includes('flowchart-N45-'),
  );
  assert.ok(await viewer.isVisible());
  const canvas = viewer.locator('.pk-diagram-fullscreen-canvas');
  assert.ok(
    await canvas.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
    'fit view never stretches beyond the visible fullscreen area',
  );
  await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert.ok(
    await canvas.evaluate((element) => element.scrollHeight > element.clientHeight),
    'zoomed view can be panned without growing the page',
  );
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('pk-transcript pk-mermaid img')].some((image) =>
      image.getAttribute('src')?.includes('flowchart-N45-'),
    ),
  );
  const finalPreview = await chart.locator('.pk-diagram-preview').boundingBox();
  assert.ok(finalPreview.height < size.visible * 0.65, 'the completed tall diagram stays bounded');
  assert.equal(await chart.locator('[role="alert"]').count(), 0);
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

it('keeps invalid final Mermaid readable as source instead of breaking the answer', async () => {
  await app.h.prompt('Show invalid diagram.');
  const chart = app.page.locator('pk-transcript pk-mermaid').last();
  await chart.locator('[role="alert"]').waitFor();
  assert.ok((await chart.locator('code').textContent()).includes('A['));
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});
