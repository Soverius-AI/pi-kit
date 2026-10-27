/** Stable UI identity for a provider/model pair. The request model string stays unchanged.
 * FNV-1a over the UTF-8 tuple avoids delimiter ambiguity and works identically in Node and browsers. */
export function modelIdentity(provider: string, model: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify([provider, model]))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `model-${hash.toString(16).padStart(16, '0')}`;
}
