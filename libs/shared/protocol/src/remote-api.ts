import { REMOTE_ROUTES } from './remote-routes.generated';

const ROUTES = REMOTE_ROUTES.map(
  ([method, template]) =>
    [
      method,
      new RegExp('^' + template.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+') + '$'),
    ] as const,
);

// One reviewed data-plane surface for paired devices and instances: the routes marked @Remote() in the backend. No administration, credentials or executable documents.
export function isReviewedRemoteApi(path: string, method: string): boolean {
  if (/^\/api\/(?:genui-sandbox|mcp-sandbox|mcp-app[^/]*|browser)(?:\/|$)/i.test(path)) return false;
  if (/^\/api\/threads\/[^/]+\/(?:browser|mcp-app[^/]*)(?:\/|$)/i.test(path)) return false;
  if (/^\/api\/(?:copilotkit|agui)\/(?:genui-sandbox|mcp-sandbox|mcp-app[^/]*)(?:\/|$)/i.test(path)) return false;
  if (/^\/api\/(?:copilotkit|agui)(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) return method === 'GET' || method === 'POST';
  if (/^\/api\/settings\/[^/]+$/.test(path))
    return method === 'PUT' && /^\/api\/settings\/(?:thread|workspace)$/.test(path);
  return ROUTES.some(([allowed, route]) => allowed === method && route.test(path));
}

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
/** Hop-by-hop names plus whatever the Connection header lists; never forwarded across a reviewed hop. */
export function hopByHopHeaders(connection: string | string[] | undefined): Set<string> {
  return new Set([
    ...HOP_BY_HOP,
    ...String(connection ?? '')
      .toLowerCase()
      .split(',')
      .map((part) => part.trim()),
  ]);
}
export const REMOTE_REQUEST_HEADER_BLOCK =
  /^(?:cookie|authorization|host|forwarded|x-forwarded-.*|proxy-.*|x-pi-device-id|x-pi-peer-.*)$/i;
export const REMOTE_RESPONSE_HEADER_BLOCK =
  /^(?:cookie|set-cookie|authorization|access-control-.*|content-security-policy|proxy-.*|x-pi-device-id|x-pi-peer-.*)$/i;
/** Remote hops carry data and streams only, never executable documents. */
export function isRemoteDataType(contentType: string | string[] | undefined): boolean {
  return /^(?:application\/(?:json|[^;\s]+\+json|x-ndjson|octet-stream)|text\/(?:event-stream|plain))(?:;|$)/i.test(
    String(contentType ?? 'application/octet-stream'),
  );
}

/** Validate raw router paths before interpreting encoded parameter segments. */
export function isRemoteApiPath(path: string): boolean {
  if (
    !path.startsWith('/api/') ||
    path.includes('\\') ||
    hasControlCharacter(path, true) ||
    path.split('/').some((s) => s === '.' || s === '..')
  )
    return false;
  try {
    return !hasControlCharacter(decodeURIComponent(path));
  } catch {
    return false;
  }
}
export function hasControlCharacter(value: string, includeSpace = false): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127 || (includeSpace && code === 32)) return true;
  }
  return false;
}
