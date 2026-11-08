import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

/** A release as GitHub's API describes it: the tag and the files attached to it. */
export interface Release {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export async function getRelease(url: string): Promise<Release> {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`the release feed answered ${response.status}`);
  return (await response.json()) as Release;
}

export async function getText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`downloading ${url} failed: ${response.status}`);
  return response.text();
}

export async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`downloading ${url} failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(file));
}
