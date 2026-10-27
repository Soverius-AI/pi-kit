/** Bound remote metadata before parsing it; neither model hubs nor local servers get an unbounded JSON buffer. */
export async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error('The server returned no response body.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error('The server response exceeded its output limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
