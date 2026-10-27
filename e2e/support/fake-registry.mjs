// A fake npm registry for the package browser: `PI_KIT_NPM_REGISTRY` points the backend at it, so the tests and the screenshots never reach the network.
//   GET /-/v1/search?text=keywords:pi-package <query>&size=20   the packages below whose name, description or keywords contain every word of the query
//   GET /<name>                                                 the package document: the latest version, its README and its `pi` key
//   GET /<name>/latest                                          the manifest of the latest version (the update check asks for it)
// `requests` is every URL asked for, in order, for the assertions that look at what the backend did.
import { createServer } from 'node:http';

export const PACKAGES = [
  {
    name: 'pi-subagents',
    version: '0.5.0',
    description: 'Run pi in sub-threads with their own tools and budget.',
    keywords: ['pi-package', 'pi-extension', 'pi-skill', 'agents'],
    downloads: 12034,
    date: '2026-10-13T08:14:02.114Z',
    license: 'MIT',
    author: 'nicolo',
    repository: 'https://github.com/nicolo/pi-subagents',
    pi: { extensions: ['./extensions/subagents.ts', './extensions/budget.ts'], skills: ['./skills'] },
    readme: '# pi-subagents\n\nSub-agents let a thread delegate a bounded task to a child session with its own tool set and token budget. Each child reports back as a tool result.\n\n## Install\n\n    pi install npm:pi-subagents\n',
  },
  {
    name: 'pi-swarm',
    version: '1.2.1',
    description: 'Fan a task out to parallel agents and merge the results.',
    keywords: ['pi-package', 'extension'],
    downloads: 3100,
    date: '2026-10-03T11:00:00.000Z',
    license: 'Apache-2.0',
    author: 'someone',
    repository: 'https://github.com/someone/pi-swarm',
    readme: '# pi-swarm\n\nParallel agents, merged.\n',
  },
  {
    name: 'skills-devops',
    version: '2.0.0',
    description: 'Terraform, Kubernetes and GitHub Actions skills.',
    keywords: ['pi-package', 'pi-skills', 'devops'],
    downloads: 800,
    date: '2026-10-01T09:30:00.000Z',
    license: 'MIT',
    author: 'devops',
    pi: { skills: ['./skills/terraform', './skills/kubernetes', './skills/actions'] },
    readme: '# skills-devops\n\nThree skills.\n',
  },
  {
    name: 'pi-review-bot',
    version: '0.9.3',
    description: 'Reviews a diff with a second model before you commit.',
    keywords: ['pi-package'],
    downloads: 2400,
    date: '2026-09-20T09:30:00.000Z',
    license: 'MIT',
    author: 'team',
    pi: { extensions: ['./extensions/review.ts'], prompts: ['./prompts/review.md'] },
    readme: '# pi-review-bot\n\nA second opinion.\n',
  },
];

const objectOf = (p) => ({
  downloads: { monthly: p.downloads, weekly: Math.round(p.downloads / 4) },
  updated: p.date,
  package: {
    name: p.name,
    version: p.version,
    description: p.description,
    keywords: p.keywords,
    date: p.date,
    links: { npm: `https://www.npmjs.com/package/${p.name}`, ...(p.repository ? { repository: p.repository } : {}) },
    author: { name: p.author },
    publisher: { username: p.author },
    license: p.license,
    ...(p.pi ? { pi: p.pi } : {}),
  },
});

export async function startFakeRegistry({ port = 0 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://registry.local');
    if (url.pathname === '/-/v1/search') {
      const words = (url.searchParams.get('text') ?? '').replace(/keywords:pi-package/, '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      const hits = PACKAGES.filter((p) => words.every((w) => `${p.name} ${p.description} ${p.keywords.join(' ')}`.toLowerCase().includes(w)));
      return void res.end(JSON.stringify({ objects: hits.map(objectOf), total: hits.length + (words.length === 0 ? 4 : 0), time: new Date().toUTCString() }));
    }
    const match = /^\/(@?[^/]+?(?:%2F[^/]+)?)(\/latest)?$/.exec(url.pathname);
    const p = match && PACKAGES.find((x) => x.name === decodeURIComponent(match[1]));
    if (!p) {
      res.statusCode = 404;
      return void res.end('{"error":"Not found"}');
    }
    const manifest = { name: p.name, version: p.version, description: p.description, license: p.license, author: { name: p.author }, repository: p.repository ? { type: 'git', url: `git+${p.repository}.git` } : undefined, ...(p.pi ? { pi: p.pi } : {}) };
    if (match[2]) return void res.end(JSON.stringify(manifest));
    res.end(JSON.stringify({ name: p.name, 'dist-tags': { latest: p.version }, time: { modified: p.date, [p.version]: p.date }, readme: p.readme, versions: { [p.version]: manifest } }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address();
  return { url: `http://127.0.0.1:${bound}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
