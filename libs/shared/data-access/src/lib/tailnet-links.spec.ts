import { TestBed } from '@angular/core/testing';
import { WORKBENCH, peersList, peersProjects, provideMockApi, workspacesWorkspaces } from '@pi-kit/api';
import { LoopbackUrl, type PeerManager } from '@pi-kit/protocol';
import { EnvironmentsStore } from './environments.store';
import { TailnetLinks } from './tailnet-links';

const self = { instanceId: '0b6c5bb4-3b1e-4a36-9ad2-7f6f8a1c2d01', name: 'ms22.local' };
const peerId = 'f1a77d38-aa39-45b9-ac63-60a662a9737d';
const manager = {
  self,
  keyInitialized: true,
  peers: [{ peerId, name: 'Mac mini', state: 'active', origin: 'https://mini.tail396e19.ts.net:8443' }],
  requests: [],
} as unknown as PeerManager;

describe('TailnetLinks', () => {
  afterEach(() => {
    document.querySelectorAll('meta[name="pi-kit-connection"], a.test-link').forEach((element) => element.remove());
    TestBed.resetTestingModule();
  });
  function setup(remote: boolean) {
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [peersList, async () => manager, () => []],
          [peersProjects, async () => [], () => []],
          [workspacesWorkspaces, async () => [], () => []],
        ]),
        { provide: WORKBENCH, useValue: remote ? { remote: true, ownerId: peerId } : { remote: false } },
      ],
    });
    const links = TestBed.inject(TailnetLinks);
    links.install();
    return { links, environments: TestBed.inject(EnvironmentsStore) };
  }
  function click(href: string): string {
    const anchor = document.createElement('a');
    anchor.className = 'test-link';
    anchor.href = href;
    anchor.addEventListener('click', (event) => event.preventDefault());
    document.body.append(anchor);
    anchor.click();
    return anchor.href;
  }

  it('rewrites only loopback http(s) hosts and keeps port, path and query', () => {
    expect(LoopbackUrl.toHost('http://localhost:5173/app?x=1#y', 'mini.ts.net')).toBe(
      'http://mini.ts.net:5173/app?x=1#y',
    );
    expect(LoopbackUrl.toHost('http://127.0.0.1:3000/', 'mini.ts.net')).toBe('http://mini.ts.net:3000/');
    expect(LoopbackUrl.toHost('http://[::1]:8080/', 'mini.ts.net')).toBe('http://mini.ts.net:8080/');
    expect(LoopbackUrl.toHost('http://0.0.0.0:4200/', 'mini.ts.net')).toBe('http://mini.ts.net:4200/');
    expect(LoopbackUrl.toHost('http://app.localhost:4200/', 'mini.ts.net')).toBe('http://mini.ts.net:4200/');
    expect(LoopbackUrl.toHost('https://example.com/', 'mini.ts.net')).toBeUndefined();
    expect(LoopbackUrl.toHost('mailto:me@localhost', 'mini.ts.net')).toBeUndefined();
    expect(LoopbackUrl.toHost('localhost:5173/app', 'mini.ts.net')).toBe('http://mini.ts.net:5173/app');
    expect(LoopbackUrl.toHost('[::1]:8080', 'mini.ts.net')).toBe('http://mini.ts.net:8080/');
    expect(LoopbackUrl.toHost('example.com', 'mini.ts.net')).toBeUndefined();
  });

  it('leaves links alone on the computer that runs the environment', () => {
    setup(false);
    expect(click('http://localhost:5173/')).toBe('http://localhost:5173/');
  });

  it("points a remote environment's loopback links at that computer's tailnet name", () => {
    const { environments } = setup(true);
    environments.manager.set(manager);
    expect(click('http://localhost:5173/docs')).toBe('http://mini.tail396e19.ts.net:5173/docs');
    expect(click('https://example.com/')).toBe('https://example.com/');
  });

  it('points loopback links on a paired phone at the address the phone uses', () => {
    const marker = document.createElement('meta');
    marker.name = 'pi-kit-connection';
    marker.content = 'device';
    document.head.append(marker);
    setup(false);
    expect(click('http://127.0.0.1:3000/')).toBe(`http://${location.hostname}:3000/`);
  });
});
