/** Test helper: builds WAV files byte by byte, in every flavour the parser has to read. */
/** A WAV file: `data` is the raw bytes of the sample frames. */
export function wavFile(data: Uint8Array, opts: { rate?: number; channels?: number; bits?: number; tag?: number; extensible?: boolean; sizeUnknown?: boolean; extraChunk?: boolean } = {}): Uint8Array {
  const { rate = 16000, channels = 1, bits = 16, tag = 1, extensible = false, sizeUnknown = false, extraChunk = false } = opts;
  const fmtSize = extensible ? 40 : 16;
  const extra = extraChunk ? 8 + 4 : 0;
  const out = new Uint8Array(12 + extra + 8 + fmtSize + 8 + data.length);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  text(8, 'WAVE');
  let at = 12;
  if (extraChunk) {
    text(at, 'LIST');
    view.setUint32(at + 4, 4, true);
    text(at + 8, 'INFO');
    at += 12;
  }
  text(at, 'fmt ');
  view.setUint32(at + 4, fmtSize, true);
  view.setUint16(at + 8, extensible ? 0xfffe : tag, true);
  view.setUint16(at + 10, channels, true);
  view.setUint32(at + 12, rate, true);
  view.setUint32(at + 16, (rate * channels * bits) / 8, true);
  view.setUint16(at + 20, (channels * bits) / 8, true);
  view.setUint16(at + 22, bits, true);
  if (extensible) {
    view.setUint16(at + 24, 22, true);
    view.setUint16(at + 26, bits, true);
    view.setUint16(at + 32, tag, true);
  }
  at += 8 + fmtSize;
  text(at, 'data');
  view.setUint32(at + 4, sizeUnknown ? 0xffffffff : data.length, true);
  out.set(data, at + 8);
  return out;
}
