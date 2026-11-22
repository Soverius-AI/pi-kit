import { Injectable } from '@nestjs/common';

/** Brand logos from Composio's public logo service, as data URLs: the app's pages may only show images of their own. Kept for the life of the process. */
@Injectable()
export class BrandLogos {
  private static readonly SOURCE = 'https://logos.composio.dev/api/';
  private static readonly LIMIT = 64_000;
  private static readonly TYPES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'];
  private readonly logos = new Map<string, string | null>();

  async of(names: string[]): Promise<Record<string, string>> {
    await Promise.all(
      names
        .filter((name) => !this.logos.has(name))
        .slice(0, 60)
        .map(async (name) => this.logos.set(name, await BrandLogos.fetch(name))),
    );
    return Object.fromEntries(
      names.flatMap((name) => {
        const logo = this.logos.get(name);
        return logo ? [[name, logo]] : [];
      }),
    );
  }

  private static async fetch(name: string): Promise<string | null> {
    try {
      const response = await fetch(`${BrandLogos.SOURCE}${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(5000),
      });
      const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!response.ok || !BrandLogos.TYPES.includes(type)) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length <= BrandLogos.LIMIT ? `data:${type};base64,${bytes.toString('base64')}` : null;
    } catch {
      return null;
    }
  }
}
