/**
 * The sandbox proxy document for MCP Apps, served by the backend at `/api/mcp-sandbox/proxy.html`.
 *
 * MCP Apps are HTML from an MCP server, so they run in two frames, the layout the MCP Apps spec prescribes: this
 * document in an iframe of the renderer with `sandbox="allow-scripts allow-same-origin allow-forms"` (it keeps the
 * backend's origin, which is not the renderer's: it cannot reach the renderer's DOM, storage or token, and the
 * backend's CORS and bearer token keep it from the API), and the app itself in a second iframe inside it,
 * `sandbox="allow-scripts allow-forms"` without `allow-same-origin`, so the app's origin is opaque even to this
 * document, and with its own Content-Security-Policy. The proxy only relays `postMessage` between the host and
 * the app and builds the app's CSP; it holds no secret, which is why the route is served without the bearer token.
 *
 * Protocol (MCP Apps, SEP-1865; the host side is `@copilotkit/angular/mcp-apps`, or ours):
 *   proxy -> host   `ui/notifications/sandbox-proxy-ready`
 *   host  -> proxy  `ui/notifications/sandbox-resource-ready` { html, csp? }  (loads the app)
 *   anything else is relayed unchanged: host -> app and app -> host.
 */

/** The CSP of the proxy document itself. The app inherits it (a `srcdoc` frame does), so it is wide; the app's own `<meta>` narrows it. */
export const SANDBOX_PROXY_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: data: https: http:",
  "style-src 'unsafe-inline' data: https: http:",
  'img-src data: blob: https: http:',
  'font-src data: https: http:',
  'media-src data: blob: https: http:',
  'connect-src https: http: ws: wss:',
  'frame-src data: blob: https: http:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const SANDBOX_PROXY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>MCP App sandbox</title>
<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%;background:transparent}</style>
</head>
<body>
<script>
(function () {
  if (window.parent === window) throw new Error('This document is a sandbox proxy and only works in an iframe.');
  var inner = null;
  function list(value) { return Array.isArray(value) ? value.filter(function (v) { return typeof v === 'string' && !/[;\\s'"]/.test(v); }).join(' ') : ''; }
  // The MCP Apps default policy: nothing but inline script and style, until the resource asks for more.
  function policy(csp) {
    csp = csp || {};
    var resources = list(csp.resourceDomains);
    var connect = list(csp.connectDomains);
    var frames = list(csp.frameDomains);
    var base = list(csp.baseUriDomains);
    return [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline' blob: data: " + resources,
      "style-src 'self' 'unsafe-inline' blob: data: " + resources,
      "img-src 'self' data: blob: " + resources,
      "font-src 'self' data: " + resources,
      "media-src 'self' data: blob: " + resources,
      "connect-src " + (connect || "'none'"),
      "frame-src " + (frames || "'none'"),
      "object-src 'none'",
      "base-uri " + (base || "'none'")
    ].join('; ');
  }
  function load(html, csp) {
    if (inner) inner.remove();
    inner = document.createElement('iframe');
    inner.setAttribute('sandbox', 'allow-scripts allow-forms');
    inner.setAttribute('title', 'MCP App');
    var meta = '<meta http-equiv="Content-Security-Policy" content="' + policy(csp).replace(/"/g, '&quot;') + '">';
    inner.srcdoc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, function (m) { return m + meta; }) : meta + html;
    document.body.appendChild(inner);
  }
  window.addEventListener('message', function (event) {
    if (event.source === window.parent) {
      var data = event.data;
      if (data && data.jsonrpc === '2.0' && data.method === 'ui/notifications/sandbox-resource-ready' && data.params && typeof data.params.html === 'string') {
        load(data.params.html, data.params.csp);
      } else if (inner && inner.contentWindow) {
        inner.contentWindow.postMessage(data, '*');
      }
    } else if (inner && event.source === inner.contentWindow) {
      window.parent.postMessage(event.data, '*');
    }
  });
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, '*');
})();
</script>
</body>
</html>
`;
