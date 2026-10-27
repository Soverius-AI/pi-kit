// A provider that is not one: an OpenAI-compatible endpoint that forwards to the local model every e2e test uses and records the `Authorization` header of what it is sent.
// The test points a built-in provider's `baseUrl` at it (pi's models.json allows that for any provider, providers.md "OpenRouter"), so a key that pi resolved through a `!command` can
// be compared with the key the person typed, without any network and without a real provider.
import { createServer } from 'node:http';

export async function startKeyProxy(targetBase, targetModel) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, authorization: req.headers['authorization'] ?? null });
    try {
      const url = `${targetBase.replace(/\/$/, '')}${req.url.replace(/^\/v1/, '')}`;
      let forwarded = body;
      if (body && req.headers['content-type']?.includes('json')) {
        const json = JSON.parse(body);
        if (json.model) json.model = targetModel;
        forwarded = JSON.stringify(json);
      }
      const upstream = await fetch(url, { method: req.method, headers: { 'Content-Type': 'application/json' }, ...(req.method === 'GET' ? {} : { body: forwarded }) });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (error) {
      res.writeHead(502);
      res.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}
