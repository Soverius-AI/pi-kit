/** A CLI can supply only a Tailscale-owned approval page, never an arbitrary URL. */
export function tailscaleApprovalUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://login.tailscale.com' || url.username || url.password || url.hash) return;
    if (url.pathname !== '/admin/dns' && !/^\/f\/(?:serve|https)(?:\/|$)/.test(url.pathname)) return;
    return url.href;
  } catch {
    return;
  }
}
