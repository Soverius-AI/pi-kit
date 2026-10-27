import { setTimeout as pause } from 'node:timers/promises';

async function text(response: Response, limit = 2_000_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('llama-swap returned an empty response.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('The llama-swap response is too large to verify safely.');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Uses the existing daemon only. Never launches a process or executes a model command itself. */
export async function reloadExistingModel(input: {
  baseUrl: string; model: string; headers: Record<string, string>; timeoutMs: number; watching: boolean;
  signal: AbortSignal; progress(detail: string): void; signalReload(): Promise<void>;
  verify(): Promise<void>;
}): Promise<void> {
  const { baseUrl, model, headers, progress } = input;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs + 60_000)]);
  const get = async (path: string, timeout = 5000): Promise<Response> => {
    const response = await fetch(`${baseUrl}${path}`, { headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? 'llama-swap rejected authentication. Check the existing service API key.' : `llama-swap could not complete the request (HTTP ${response.status}).`); }
    return response;
  };
  const version = JSON.parse(await text(await get('/api/version'))) as { version?: string };
  const release = /^v?(\d+)(?:$|[-.])/.exec(version.version ?? '');
  if (!release || Number(release[1]) < 262) throw new Error('Immediate reload requires llama-swap v262 or newer. Saved settings can still apply on the next service reload.');
  const before = await text(await get('/logs'));
  if (!before.trim()) throw new Error('Immediate reload needs llama-swap proxy logs to confirm the config was applied. Saved settings are retained.');
  const marker = (log: string): string[] => log.split('\n').filter((line) => line.includes('configuration reloaded'));
  const initial = marker(before);
  const initialFailures = before.split('\n').filter((line) => /failed to reload config|failed to build new server during reload/.test(line));
  const inspect = async (): Promise<boolean> => {
    const logs = await text(await get('/logs'));
    const failures = logs.split('\n').filter((line) => /failed to reload config|failed to build new server during reload/.test(line));
    if (failures.length > initialFailures.length || failures.some((line) => !initialFailures.includes(line))) throw new Error('llama-swap rejected the saved configuration. Review its service logs; your saved settings are retained.');
    const current = marker(logs);
    return current.length > initial.length || current.some((line) => !initial.includes(line));
  };
  let confirmed = false;
  if (input.watching) {
    progress('Waiting for the existing config watcher…');
    const until = Date.now() + 2500;
    while (Date.now() < until && !confirmed) {
      await pause(250, undefined, { signal });
      confirmed = await inspect();
    }
  }
  if (!confirmed) {
    progress('Reloading the existing llama-swap configuration…');
    await input.signalReload();
    const until = Date.now() + 45_000;
    while (Date.now() < until && !confirmed) {
      await pause(250, undefined, { signal });
      confirmed = await inspect();
    }
  }
  if (!confirmed) throw new Error('Could not confirm that llama-swap reloaded the config. Saved settings are retained. Check proxy logging and retry.');
  await input.verify();
  progress(`Loading ${model} with the saved settings…`);
  const path = model.split('/').map(encodeURIComponent).join('/');
  const load = await fetch(`${baseUrl}/upstream/${path}/`, { headers, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]) });
  await load.body?.cancel();
  if (load.status >= 500 || load.status === 401 || load.status === 403) throw new Error(`llama-swap could not load the model (HTTP ${load.status}). Saved settings are retained. Review its service logs and retry.`);
  const until = Date.now() + Math.min(input.timeoutMs, 30_000);
  while (Date.now() < until) {
    signal.throwIfAborted();
    const running = JSON.parse(await text(await get('/running'))) as { running?: { model?: string; state?: string }[] };
    if (Array.isArray(running.running) && running.running.some((entry) => entry.model === model && entry.state === 'ready')) {
      await input.verify();
      progress(`${model} is ready with the saved settings.`); return;
    }
    await pause(500, undefined, { signal });
  }
  throw new Error('The model did not become ready after reload. Saved settings are retained. Review llama-swap logs and retry.');
}
