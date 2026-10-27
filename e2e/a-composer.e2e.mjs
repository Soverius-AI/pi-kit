// End to end: the compact composer toolbar and voice input. Run with `pnpm run e2e` (`-- --file a-composer` for just this).
// The backend of the scratch world uses the test engine and a fixture "model" (e2e/support/env.mjs, `voiceEnv`), so nothing needs the network or the
// real Whistle file; the browser has a fake microphone (e2e/support/fake-mic.mjs) that plays e2e/fixtures/voice/sentence.wav in a loop. What each part proves:
//   - the toolbar: measured at four widths, idle and while pi runs; every control is 32px tall (28px inside the tools pill) and inside the well;
//   - the first use asks before it downloads, and the download is checked against its pinned hash;
//   - a WAV through POST /api/transcribe is parsed, downmixed and resampled (the test engine says what length of 16 kHz audio it received);
//   - the stream and live routes carry partial text; and holding ⌥Space in the composer puts the sentence in the text field, unsent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { api, env, openApp } from './support/app.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const SENTENCE = join(here, 'fixtures', 'voice', 'sentence.wav');

let app;
let mic;
before(async () => {
  app = await openApp();
  mic = await openApp({ microphone: SENTENCE });
});
after(async () => {
  await mic?.close();
  await app?.close();
});

/** A request with the dev token and a raw body (`api` only does JSON). */
async function raw(path, init = {}) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  return fetch(`${env.api}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
}

/** Parses a server-sent-events body into `{ event, data }` messages. */
function sse(text) {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null') }));
}

/** A 16-bit mono WAV of a tone: `channels` copies of it, at `rate`. */
function wav({ seconds, rate = 16000, channels = 1, amplitude = 0.4 }) {
  const frames = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + frames * channels * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 300 * i) / rate));
    for (let c = 0; c < channels; c++) out.writeInt16LE(v, 44 + (i * channels + c) * 2);
  }
  return out;
}

const post = (path, body, type = 'audio/wav') => raw(path, { method: 'POST', headers: { 'Content-Type': type }, body });
const composerValue = (page) => page.getByLabel('Message to pi').inputValue();

/** Every control of the toolbar with its box, and whether it sits in the well. */
async function measure(page) {
  return page.evaluate(() => {
    const well = document.querySelector('.pk-well').getBoundingClientRect();
    const bar = document.querySelector('pk-composer-toolbar');
    const rows = [...bar.querySelectorAll('button, .pk-tools, .pk-chip')]
      .filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('.pk-popover') && !e.closest('.pk-usage-pop'))
      .map((e) => {
        const b = e.getBoundingClientRect();
        return {
          name: e.getAttribute('aria-label') ?? e.className,
          tag: e.tagName.toLowerCase(),
          left: b.left,
          right: b.right,
          top: Math.round(b.top),
          height: b.height,
          inPill: !!e.closest('.pk-tools') && !e.classList.contains('pk-tools'),
        };
      });
    return { well: { left: well.left, right: well.right }, overflow: bar.scrollWidth - bar.clientWidth, rows };
  });
}

const VIEWS = [
  [1440, 900],
  [1024, 768],
  [768, 1024],
  [375, 812],
];

describe('the compact composer toolbar', () => {
  it('is one row of 32px controls (two under 768px) that never leave the well, at four widths', async () => {
    const { page, h } = app;
    await h.newThread();
    for (const [width, height] of [...VIEWS, [375, 649]]) {
      await page.setViewportSize({ width, height });
      await h.settle(300);
      const welcome = await page.getByTestId('new-thread-page').locator('h2').boundingBox();
      const transcript = await page.locator('[cdkscrollable]').boundingBox();
      assert.ok(welcome && transcript && welcome.y >= transcript.y, `${width}×${height}: the empty-thread heading is clipped`);
      assert.equal(await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).count(), 0, 'an empty thread has no latest message to jump to');
      const m = await measure(page);
      assert.equal(m.overflow, 0, `${width}: the toolbar scrolls`);
      const names = m.rows.map((r) => r.name).join(' | ');
      for (const wanted of ['Model', /^Thinking effort:/, 'Dictate', 'Send']) {
        assert.ok(m.rows.some((r) => (wanted instanceof RegExp ? wanted.test(r.name) : r.name === wanted)), `${width}: no ${wanted} in ${names}`);
      }
      assert.ok(m.rows.some((r) => r.name.startsWith('Context')), `${width}: no context ring`);
      for (const r of m.rows) {
        assert.equal(r.height, r.inPill ? 28 : 32, `${width}: ${r.name} is ${r.height}px tall`);
        assert.ok(r.left >= m.well.left - 0.5 && r.right <= m.well.right + 0.5, `${width}: ${r.name} (${r.left}-${r.right}) leaves the well (${m.well.left}-${m.well.right})`);
      }
      const rowsOfControls = new Set(m.rows.filter((r) => !r.inPill).map((r) => r.top)).size;
      assert.equal(rowsOfControls, width < 768 ? 2 : 1, `${width}: ${rowsOfControls} rows of controls`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it('adds the Deliver chip while pi runs, keeps it inside the well, and the one round button turns into Stop', async () => {
    const { page, h } = app;
    await h.newThread();
    assert.equal(await page.getByRole('button', { name: /^Deliver/ }).count(), 0);
    await h.startPrompt('Count from 1 to 80, one number per line, and write nothing else.');
    const chip = page.getByRole('button', { name: /^Deliver/ });
    await chip.waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).count(), 0);
    for (const [width, height] of VIEWS) {
      await page.setViewportSize({ width, height });
      await h.settle(250);
      const m = await measure(page);
      assert.equal(m.overflow, 0, `${width}: the toolbar scrolls while running`);
      assert.ok(m.rows.some((r) => r.name === 'Stop'), `${width}: no Stop`);
      for (const r of m.rows) {
        assert.equal(r.height, r.inPill ? 28 : 32, `${width} running: ${r.name} is ${r.height}px tall`);
        assert.ok(r.left >= m.well.left - 0.5 && r.right <= m.well.right + 0.5, `${width} running: ${r.name} leaves the well`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // Steer / Follow-up is a chip with a menu.
    assert.match(await chip.getAttribute('aria-label'), /Steer/);
    await chip.click();
    await page.getByRole('option', { name: /^Follow-up/ }).click();
    await page.getByRole('button', { name: 'Deliver, Follow-up' }).waitFor();
    await page.getByRole('button', { name: /^Deliver/ }).click();
    await page.getByRole('option', { name: /^Steer/ }).click();
    await page.getByTestId('stop').click();
    await page.getByTestId('stop').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  });

  it('opens the usage popover from the ring, with the numbers and the two links', async () => {
    const { page } = app;
    const ring = page.getByTestId('context-meter');
    await ring.waitFor();
    await ring.click();
    const pop = page.getByTestId('usage-popover');
    await pop.waitFor();
    const text = await pop.innerText();
    assert.match(text, /of context/);
    assert.match(text, /Compacts at/);
    assert.match(text, /This thread/);
    assert.match(text, /Cache hit/);
    assert.ok(await pop.getByRole('button', { name: 'Usage by turn' }).isVisible());
    assert.ok(await pop.getByRole('button', { name: 'Compact now' }).isVisible());
    // Inside the viewport at every width, Esc and a click elsewhere close it.
    for (const [width, height] of VIEWS) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(200);
      const box = await pop.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `${width}: the popover is at ${box.x}..${box.x + box.width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press('Escape');
    await pop.waitFor({ state: 'detached' });
    await ring.click();
    await pop.waitFor();
    await page.mouse.click(5, 300);
    await pop.waitFor({ state: 'detached' });
    await ring.click();
    await pop.getByRole('button', { name: 'Usage by turn' }).click();
    await page.getByRole('dialog', { name: 'Usage' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Usage' }).waitFor({ state: 'detached' });
  });
});

describe('voice input: the model, the API', () => {
  it('starts with no model, refuses to download without consent, and refuses to transcribe', async () => {
    const status = await api('/api/transcribe/status');
    assert.equal(status.engine, 'fake');
    assert.equal(status.model.state, 'missing');
    assert.equal(status.model.name, 'Whistle');
    const refused = await raw('/api/transcribe/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(refused.status, 400);
    assert.equal((await api('/api/transcribe/status')).model.state, 'missing');
    const tooEarly = await post('/api/transcribe', wav({ seconds: 1 }));
    assert.equal(tooEarly.status, 409);
    assert.match((await tooEarly.json()).message, /Download Whistle/);
  });

  it('asks in the hint row on first use; the download starts only with the click, and is checked against its hash', async () => {
    const { page, h } = app;
    await h.newThread();
    await page.getByRole('button', { name: 'Dictate' }).click();
    const hint = page.getByTestId('voice-hint');
    // The hint says "Starting the microphone…" for a moment before it finds no model and asks for the download.
    await hint.getByText(/one-time \d+ MB download/).waitFor();
    // Nothing was fetched yet.
    assert.equal((await api('/api/transcribe/status')).model.state, 'missing');
    const button = page.getByTestId('voice-download');
    assert.match(await button.innerText(), /Download Whistle \(\d+ MB\)/);
    await button.click();
    await page.locator('.toast', { hasText: /Whistle is ready/ }).waitFor();
    const status = await api('/api/transcribe/status');
    assert.equal(status.model.state, 'ready');
    assert.match(status.model.path, /models[\\/]whistle[\\/]whistle\.cact$/);
    assert.match(status.model.sha256, /^[0-9a-f]{64}$/);
    assert.equal(await page.getByTestId('voice-download').count(), 0);
  });

  it('transcribes a recorded WAV: the engine receives 16 kHz mono audio of the right length', async () => {
    const sentence = readFileSync(SENTENCE);
    const result = await (await post('/api/transcribe?language=en', sentence)).json();
    assert.match(result.text, /^fixture heard 2\.8 seconds of sound in en\.$/);
    assert.equal(result.language, 'en');
    assert.ok(Math.abs(result.durationMs - 2809) <= 2, String(result.durationMs));
    assert.ok(result.tookMs >= 0);
    // 1.5 s of stereo at 48 kHz is converted down to 1.5 s of 16 kHz mono.
    assert.match((await (await post('/api/transcribe', wav({ seconds: 1.5, rate: 48000, channels: 2 }))).json()).text, /^fixture heard 1\.5 seconds of sound\.$/);
    // Silence is not sent to the engine at all.
    assert.deepEqual((await (await post('/api/transcribe', wav({ seconds: 1, amplitude: 0 }))).json()).text, '');
    // What it cannot read is a 4xx that says why.
    const bad = await post('/api/transcribe', Buffer.from('not audio at all, just words'), 'application/octet-stream');
    assert.equal(bad.status, 415);
    assert.match((await bad.json()).message, /Unknown audio format|ffmpeg/);
  });

  it('streams partial text as server-sent events, then the whole result', async () => {
    const res = await post('/api/transcribe/stream?language=en', readFileSync(SENTENCE));
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = sse(await res.text());
    const partials = events.filter((e) => e.event === 'partial');
    assert.ok(partials.length >= 3, `${partials.length} partial events`);
    assert.equal(events.at(-1).event, 'done');
    // The committed words and the final tail make the sentence the one-shot route gave.
    const committed = partials.map((p) => p.data.text).filter(Boolean).join(' ');
    assert.match(committed, /^fixture heard/);
    assert.match(events.at(-1).data.result.text, /^fixture heard 2\.8 seconds of sound in en\.$/);
    assert.match(partials[0].data.pending, /\S/);
  });

  it('transcribes live: chunks of PCM go up while the events come down', async () => {
    const { id } = await (await raw('/api/transcribe/live?language=en', { method: 'POST' })).json();
    const events = raw(`/api/transcribe/live/${id}/events`).then((r) => r.text());
    const pcm = readFileSync(SENTENCE).subarray(44);
    for (let at = 0; at < pcm.length; at += 32000) {
      const sent = await raw(`/api/transcribe/live/${id}/chunk`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm.subarray(at, at + 32000) });
      assert.equal(sent.status, 204);
    }
    const result = await (await raw(`/api/transcribe/live/${id}/end`, { method: 'POST' })).json();
    assert.match(result.text, /^fixture heard 2\.8 seconds of sound in en\.$/);
    const seen = sse(await events);
    assert.ok(seen.filter((e) => e.event === 'partial').length >= 3);
    assert.equal(seen.at(-1).event, 'done');
    // A session that is over is a 409.
    assert.equal((await raw(`/api/transcribe/live/${id}/chunk`, { method: 'POST', body: Buffer.alloc(4) })).status, 409);
  });
});

describe('voice input: dictating into the composer with a fake microphone', () => {
  it('holding ⌥Space shows the words as they are recognised and inserts the sentence when the key is released, unsent', async () => {
    const { page, h } = mic;
    await h.newThread();
    const box = page.getByLabel('Message to pi');
    await box.fill('Please say: ');
    await box.focus();
    await page.keyboard.down('Alt');
    await page.keyboard.down('Space');
    await page.getByTestId('voice-hint').filter({ hasText: /Listening|fixture/ }).waitFor();
    assert.ok(await page.locator('.pk-well copilot-chat-audio-recorder canvas').isVisible(), 'CopilotKit’s waveform has taken the editor row');
    assert.equal(await page.getByLabel('Message to pi').count(), 0, 'the textarea is swapped out while listening');
    // Live: the first committed words arrive while the key is still down.
    await page.getByTestId('voice-hint').filter({ hasText: /fixture/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Finish dictating' }).getAttribute('aria-pressed'), 'true');
    const started = Date.now();
    await page.keyboard.up('Space');
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => /fixture heard \d+\.\d seconds of sound/.test(document.querySelector('[aria-label="Message to pi"]')?.value ?? ''), undefined);
    const after = Date.now() - started;
    const value = await composerValue(page);
    assert.match(value, /^Please say: fixture heard \d+\.\d seconds of sound\.$/);
    assert.ok(after < 4000, `the text took ${after} ms after the key was released`);
    // Not sent: no run started, the text is still in the composer.
    assert.equal(await page.getByTestId('stop').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Dictate' }).count(), 1);
    assert.equal(await page.getByTestId('voice-hint').count(), 0);
    // No no-break space from ⌥Space went into the text.
    assert.ok(!value.includes(' '));
  });

  it('the microphone button toggles, and without live words the recording is converted and uploaded', async () => {
    const { page, h } = mic;
    await h.newThread();
    await h.openSettings('Voice');
    await page.getByTestId('section-voice').getByRole('tab', { name: 'Dictation', exact: true }).click();
    const live = page.getByTestId('voice-live');
    await live.uncheck();
    await h.settle(400);
    await page.keyboard.press('Escape');
    await page.getByLabel('Message to pi').waitFor();
    await page.getByRole('button', { name: 'Dictate' }).click();
    await page.getByRole('button', { name: 'Finish dictating' }).waitFor();
    await h.settle(1800);
    await page.getByRole('button', { name: 'Finish dictating' }).click();
    await page.waitForFunction(() => /fixture heard \d+\.\d seconds of sound/.test(document.querySelector('[aria-label="Message to pi"]')?.value ?? ''), undefined);
    await h.openSettings('Voice');
    await page.getByTestId('section-voice').getByRole('tab', { name: 'Dictation', exact: true }).click();
    await page.getByTestId('voice-live').check();
    await h.settle(300);
    await page.keyboard.press('Escape');
  });

  it('"send when done" sends the transcript as a message', async () => {
    const { page, h } = mic;
    await h.newThread();
    await h.openSettings('Voice');
    await page.getByTestId('section-voice').getByRole('tab', { name: 'Dictation', exact: true }).click();
    await page.getByTestId('voice-send').check();
    await h.settle(300);
    await page.keyboard.press('Escape');
    const box = page.getByLabel('Message to pi');
    await box.focus();
    await page.keyboard.down('Alt');
    await page.keyboard.down('Space');
    await page.getByTestId('voice-hint').waitFor();
    await h.settle(1800);
    await page.keyboard.up('Space');
    await page.keyboard.up('Alt');
    await page.locator('.pk-user', { hasText: /fixture heard/ }).first().waitFor();
    assert.equal(await composerValue(page), '');
    const stop = page.getByTestId('stop');
    if (await stop.count()) await stop.click();
    await stop.waitFor({ state: 'detached' });
    await h.openSettings('Voice');
    await page.getByTestId('section-voice').getByRole('tab', { name: 'Dictation', exact: true }).click();
    await page.getByTestId('voice-send').uncheck();
    await h.settle(300);
    await page.keyboard.press('Escape');
  });

  it('Esc while listening throws the recording away', async () => {
    const { page, h } = mic;
    await h.newThread();
    const box = page.getByLabel('Message to pi');
    await box.focus();
    await page.keyboard.down('Alt');
    await page.keyboard.down('Space');
    await page.getByTestId('voice-hint').filter({ hasText: /Listening|fixture/ }).waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.up('Space');
    await page.keyboard.up('Alt');
    await page.getByTestId('voice-hint').waitFor({ state: 'detached' });
    await h.settle(500);
    assert.equal(await composerValue(page), '');
  });
});

describe('Settings › Voice', () => {
  it('shows the engine and the model, the choices, and removes the model on request', async () => {
    const { page, h } = app;
    await h.newThread();
    const dialog = await h.openSettings('Voice');
    const note = dialog.getByTestId('voice-engine-note');
    await note.waitFor();
    const text = await note.innerText();
    assert.match(text, /Engine: test engine/);
    assert.match(text, /whistle\.cact/);
    assert.match(text, /SHA-256/);
    assert.equal((await dialog.getByTestId('voice-model-state').innerText()).trim(), 'ready');
    const voice = dialog.getByTestId('section-voice');
    assert.equal(await dialog.getByTestId('voice-language').isVisible(), false);
    await voice.getByRole('tab', { name: 'Privacy', exact: true }).click();
    // The panel switches after the click: wait for its text instead of reading the old tab.
    await voice.getByText(/never leaves|local only|nothing is sent/i).first().waitFor();
    await voice.getByRole('tab', { name: 'Dictation', exact: true }).click();
    assert.equal(await dialog.getByTestId('voice-key').innerText(), '⌥Space');
    // The language is saved in pi-kit's database.
    await dialog.getByTestId('voice-language').selectOption('de');
    await h.settle(500);
    const saved = await api('/api/settings');
    assert.equal(saved['voice.language'], 'de');
    await dialog.getByTestId('voice-language').selectOption('auto');
    await voice.getByRole('tab', { name: 'Speech model', exact: true }).click();
    await dialog.getByTestId('voice-remove').click();
    await dialog.getByTestId('voice-download').waitFor();
    assert.equal((await api('/api/transcribe/status')).model.state, 'missing');
    assert.equal((await dialog.getByTestId('voice-model-state').innerText()).trim(), 'not downloaded');
    await dialog.getByTestId('voice-download').click();
    await dialog.getByTestId('voice-remove').waitFor();
    assert.equal((await api('/api/transcribe/status')).model.state, 'ready');
    await page.keyboard.press('Escape');
  });
});
