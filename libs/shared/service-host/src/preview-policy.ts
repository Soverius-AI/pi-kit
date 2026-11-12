import { previewOrigins } from '@pi-kit/protocol';

export class PreviewOrigins {
  static configured(injected?: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
    const value = env.PI_KIT_PREVIEW_ORIGINS;
    return previewOrigins(injected ?? (value?.trim() ? value.split(',').map((part) => part.trim()) : []));
  }

  static permitted(
    configured: readonly string[],
    ownOrigins: readonly string[],
    backendUrl?: string,
    cookieHostname?: string,
  ): string[] {
    const blocked = new Set(ownOrigins);
    if (backendUrl) {
      try {
        blocked.add(new URL(backendUrl).origin);
      } catch {
        return [];
      }
    }
    return configured.filter((origin) => !blocked.has(origin) && new URL(origin).hostname !== cookieHostname);
  }

  static meta(origins: readonly string[]): string {
    const content = JSON.stringify(origins)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/'/g, '&#39;');
    return `<meta name="pi-kit-preview-origins" content="${content}">`;
  }
}
