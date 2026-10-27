/**
 * `HTTPS_PROXY` for the backend's own requests. pi's command line calls `configureHttpDispatcher()` to honour the proxy variables; the SDK, which the backend
 * runs in-process, does not, so a pi-kit behind a company proxy could not reach any provider. Node 24 can do it for `fetch` and `http` itself when it starts with
 * `NODE_USE_ENV_PROXY=1`, and the backend is a child process whose environment the desktop app (and `scripts/dev.mjs`) sets. `NO_PROXY` always lists the loopback addresses:
 * the local-model probes and pi's calls to llama-swap or Ollama must never go through a proxy.
 */
const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const;

export function proxyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!PROXY_VARIABLES.some((name) => env[name])) return {};
  const noProxy = [env['NO_PROXY'] ?? env['no_proxy'], 'localhost,127.0.0.1,::1'].filter(Boolean).join(',');
  return { NODE_USE_ENV_PROXY: '1', NO_PROXY: noProxy, no_proxy: noProxy };
}
