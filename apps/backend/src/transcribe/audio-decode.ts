import { spawn, spawnSync } from 'node:child_process';
import { AudioError, parseWav, pcm16ToFloat, sniffAudioFormat, toWhistleRate, WHISTLE_RATE } from './pcm';

/**
 * Any recording to Whistle's 16 kHz mono floats. A WAV file is read here, in TypeScript. The recorder of the browser makes WebM/Opus
 * (or MP4 in Safari), which needs a decoder: the renderer converts to WAV before it uploads, so this path is for the cases where it could not
 * (and for callers of the API that have a recording in another format), and uses `ffmpeg` when the program is installed.
 */

const FFMPEG_TIMEOUT_MS = 60_000;
const CANDIDATES = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

/** The `ffmpeg` to use, or undefined: `PI_KIT_FFMPEG`, then the PATH and the usual install folders. Looked up once. */
let cachedFfmpeg: { path: string | undefined } | undefined;
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cachedFfmpeg && env === process.env) return cachedFfmpeg.path;
  const wanted = env['PI_KIT_FFMPEG'];
  const found = (wanted ? [wanted] : CANDIDATES).find((candidate) => spawnSync(candidate, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0);
  if (env === process.env) cachedFfmpeg = { path: found };
  return found;
}

/** For tests. */
export function forgetFfmpeg(): void {
  cachedFfmpeg = undefined;
}

function viaFfmpeg(bytes: Uint8Array, ffmpeg: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(WHISTLE_RATE), 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new AudioError(`ffmpeg could not start: ${error.message}`, 415));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new AudioError(`ffmpeg could not read the recording: ${Buffer.concat(err).toString('utf8').trim().split('\n').pop() ?? `exit ${code}`}`, 415));
      const all = Buffer.concat(out);
      resolve(pcm16ToFloat(new Uint8Array(all.buffer, all.byteOffset, all.byteLength)));
    });
    child.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}

/** Decodes a recording to 16 kHz mono floats; `ffmpeg` is the path of the program for the formats this file cannot read itself. */
export async function decodeAudio(bytes: Uint8Array, ffmpeg: string | undefined = findFfmpeg()): Promise<Float32Array> {
  if (bytes.length === 0) throw new AudioError('The recording is empty.');
  const format = sniffAudioFormat(bytes);
  if (format === 'wav') return toWhistleRate(parseWav(bytes));
  if (!ffmpeg) {
    throw new AudioError(
      format === 'unknown' ? 'Unknown audio format; send a WAV file.' : `A ${format.toUpperCase()} recording needs ffmpeg, which is not installed. Send 16 kHz WAV (pi-kit's composer does) or install ffmpeg.`,
      415,
    );
  }
  return viaFfmpeg(bytes, ffmpeg);
}
