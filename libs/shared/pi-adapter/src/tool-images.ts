/** Keep inline tool images separate from the textual tool result. */
export function toolImages(content: unknown): { data: string; mimeType: string }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== 'object') return [];
    const image = block as Record<string, unknown>;
    if (image['type'] !== 'image' || typeof image['data'] !== 'string' || !image['data']) return [];
    const mimeType = typeof image['mimeType'] === 'string' ? image['mimeType'] : 'image/png';
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/i.test(mimeType)) return [];
    return [{ data: image['data'], mimeType }];
  });
}
