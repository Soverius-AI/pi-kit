/** Addresses this site is willing to hand a browser to: private Tailscale HTTPS origins only. */
export class RemoteAddress {
  static origin(value: string): string | undefined {
    try {
      const url = new URL(value.trim());
      const ok =
        url.protocol === 'https:' &&
        /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(url.hostname) &&
        !url.username &&
        !url.password;
      return ok ? url.origin : undefined;
    } catch {
      return undefined;
    }
  }

  static pairingLink(value: string): string | undefined {
    try {
      const url = new URL(value.trim());
      const ok =
        RemoteAddress.origin(url.origin) &&
        url.pathname === '/phone' &&
        !url.search &&
        /^#[A-Z2-7]{12}$/.test(url.hash);
      return ok ? url.href : undefined;
    } catch {
      return undefined;
    }
  }
}
