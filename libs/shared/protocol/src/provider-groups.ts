/** Presentation only: keep connection IDs intact for model selection, pins and saved defaults. */
export function providerFamily(provider: { id: string; name?: string }): { id: string; name: string } {
  const llama = /(?:^|[^a-z0-9])llama(?:[._ -]?cpp|[._ -]?swap)(?:$|[^a-z0-9])/i;
  return llama.test(provider.id) || llama.test(provider.name ?? '')
    ? { id: 'llama.cpp', name: 'llama.cpp' }
    : { id: provider.id, name: provider.name ?? provider.id };
}

/** One display group for llama.cpp and llama-swap connections, preserving connection order. */
export function groupProviders<T extends { id: string; name?: string }>(
  providers: readonly T[],
): { id: string; name: string; connections: T[] }[] {
  const groups = new Map<string, { id: string; name: string; connections: T[] }>();
  for (const provider of providers) {
    const family = providerFamily(provider);
    const group = groups.get(family.id);
    if (group) group.connections.push(provider);
    else groups.set(family.id, { ...family, connections: [provider] });
  }
  return [...groups.values()];
}
