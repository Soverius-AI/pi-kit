import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeechLanguage } from '@pi-kit/protocol';
import { floatToPcm16, WHISTLE_RATE } from './pcm';
import type { EngineChunk, EngineOptions, EngineResult, SpeechEngine } from './speech-engine';

/**
 * The fallback engine: the Python `cactus-needle` package (`pip install cactus-needle`, imported as `needle`) run as a child process
 * for one recording at a time. It is used only when the WASM engine cannot be loaded, and Settings says so. The package sends anonymous usage
 * counts unless told not to; this engine always tells it not to (`NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK=1`), and points it at the model file
 * pi-kit downloaded (`NEEDLE_WHISTLE_WEIGHTS`) so it fetches nothing.
 */

const SCRIPT = `
import json, sys, wave, array
import needle
path, language = sys.argv[1], sys.argv[2] or None
with wave.open(path, "rb") as w:
    raw = w.readframes(w.getnframes())
pcm = array.array("h"); pcm.frombytes(raw)
samples = array.array("f", (v / 32768.0 for v in pcm))
out = needle.transcribe(samples, language=language)
print(json.dumps({"text": out.get("text", ""), "language": out.get("language", "")}))
`;

const PYTHONS = ['python3', 'python'];

/** The Python that can import `needle`, or undefined. Looked up once, only when the WASM engine failed. */
let probed: { python: string | undefined } | undefined;
export function findPythonWithNeedle(): string | undefined {
  if (probed) return probed.python;
  const cwd = mkdtempSync(join(tmpdir(), 'pi-kit-py-'));
  try {
    const python = PYTHONS.find((candidate) => spawnSync(candidate, ['-c', 'import needle'], { cwd, stdio: 'ignore', timeout: 15_000, env: childEnv() }).status === 0);
    probed = { python };
    return python;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function forgetPythonProbe(): void {
  probed = undefined;
}

const childEnv = (weights?: string): NodeJS.ProcessEnv => ({
  ...process.env,
  NEEDLE_TELEMETRY: '0',
  DO_NOT_TRACK: '1',
  ...(weights ? { NEEDLE_WHISTLE_WEIGHTS: weights } : {}),
});

function wav(pcm: Float32Array): Buffer {
  const data = floatToPcm16(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(WHISTLE_RATE, 24);
  header.writeUInt32LE(WHISTLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * The `SpeechEngine` over the Python `needle` package: each recording is written as a WAV file into a scratch folder and
 * handed to one child process, whose JSON line on stdout is the text and the language. A recording that takes longer than
 * two minutes or is aborted kills the child; nothing stays running between calls.
 */
export class PythonEngine implements SpeechEngine {
  readonly kind = 'python' as const;

  constructor(
    private readonly python: string,
    private readonly modelPath: string,
  ) {}

  async transcribe(pcm: Float32Array, options: EngineOptions = {}): Promise<EngineResult> {
    const dir = mkdtempSync(join(tmpdir(), 'pi-kit-py-'));
    try {
      const file = join(dir, 'in.wav');
      writeFileSync(file, wav(pcm));
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(this.python, ['-c', SCRIPT, file, options.language ?? ''], { cwd: dir, env: childEnv(this.modelPath), stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
        options.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
        child.stdout.on('data', (c: Buffer) => stdout.push(c));
        child.stderr.on('data', (c: Buffer) => stderr.push(c));
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
          else reject(new Error(`The Python needle package failed: ${Buffer.concat(stderr).toString('utf8').trim().split('\n').pop() ?? `exit ${code}`}`));
        });
      });
      const parsed = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { text?: string; language?: string };
      return { text: (parsed.text ?? '').trim(), language: (parsed.language ?? '') as SpeechLanguage | '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** No live partials from this engine: the chunks are collected and transcribed at the end, as one final update. */
  async *stream(chunks: AsyncIterable<Float32Array>, options: EngineOptions = {}): AsyncGenerator<EngineChunk, void, void> {
    const parts: Float32Array[] = [];
    for await (const chunk of chunks) parts.push(chunk);
    const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    const result = await this.transcribe(all, options);
    yield { text: result.text, pending: '', language: result.language, receivedSeconds: all.length / WHISTLE_RATE };
  }

  async close(): Promise<void> {
    // Nothing stays running between calls.
  }
}
