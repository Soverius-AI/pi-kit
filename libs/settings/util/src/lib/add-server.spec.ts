import { english } from '@pi-kit/i18n/testing';
import { CONNECTOR_CATALOG } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import * as w from './add-server';

const catalog = CONNECTOR_CATALOG;
const authOf = (id: string): string | undefined => catalog.connectors.find((c) => c.id === id)?.auth.type;

describe('the Add a server wizard', () => {
  it('starts at the gallery, for the user file, with an empty form', () => {
    const s = w.startAddServer();
    expect(s).toMatchObject({ step: 'gallery', scope: 'user', query: '', direction: 'forward' });
    expect(s.draft).toMatchObject({ name: '', kind: 'url', exposure: 'codemode' });
    expect(w.footHint.bind(undefined, english)(s)).toBe('Step 1 of 2, next: details');
    expect(w.startAddServer('project').scope).toBe('project');
  });

  it('goes from the gallery to the details with the service’s own defaults, and back', () => {
    let s = w.chooseServer(w.startAddServer(), 'linear', catalog);
    expect(s).toMatchObject({ step: 'details', choice: 'linear', direction: 'forward' });
    expect(s.draft.name).toBe('linear');
    expect(s.draft.exposure).toBe(catalog.connectors.find((c) => c.id === 'linear')?.exposure);
    s = w.backToGallery(s);
    expect(s).toMatchObject({ step: 'gallery', direction: 'back' });
    s = w.chooseServer(s, w.CUSTOM, catalog);
    expect(s).toMatchObject({ step: 'details', choice: 'custom' });
    expect(s.draft.name).toBe('');
    // an id that is not in the catalog is a server of your own
    expect(w.chooseServer(w.startAddServer(), 'nope', catalog).choice).toBe('custom');
    expect(w.startAt('github', catalog).step).toBe('details');
  });

  it('searches the catalog by name, vendor and purpose', () => {
    expect(w.filterCatalog(catalog, '').length).toBe(catalog.connectors.length);
    expect(w.filterCatalog(catalog, 'LINEAR').map((c) => c.id)).toContain('linear');
    expect(w.filterCatalog(catalog, 'zzzz')).toEqual([]);
    expect(w.filterCatalog(catalog, 'jira').map((c) => c.id)).toContain('atlassian');
    expect(w.showsCustom('')).toBe(true);
    expect(w.showsCustom('command')).toBe(true);
    expect(w.showsCustom('zzzz')).toBe(false);
  });

  it('splits a command line the way pi takes it', () => {
    expect(w.splitCommand('npx -y @modelcontextprotocol/server-filesystem .')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '.',
    ]);
    expect(w.splitCommand('node "/Users/me/My Tools/server.js" \'two words\'')).toEqual([
      'node',
      '/Users/me/My Tools/server.js',
      'two words',
    ]);
    expect(w.splitCommand('  uvx   tools-mcp  ')).toEqual(['uvx', 'tools-mcp']);
    expect(w.splitCommand('')).toEqual([]);
  });

  it('checks the details of a server of your own before anything is written', () => {
    let s = w.chooseServer(w.startAddServer(), 'custom', catalog);
    expect(w.validateServer.bind(undefined, english)(s, catalog)?.field).toBe('name');
    s = w.patchDraft(s, { name: 'bad name' });
    expect(w.validateServer.bind(undefined, english)(s, catalog)?.message).toMatch(/letters, digits/);
    s = w.patchDraft(s, { name: 'docs-search', url: 'http://example.com/mcp' });
    expect(w.validateServer.bind(undefined, english)(s, catalog)?.field).toBe('url');
    s = w.patchDraft(s, { url: 'http://localhost:3000/mcp' });
    expect(w.validateServer.bind(undefined, english)(s, catalog)).toBeUndefined();
    s = w.patchDraft(s, { url: 'https://docs.internal.example/mcp' });
    expect(w.validateServer.bind(undefined, english)(s, catalog)).toBeUndefined();
    s = w.patchDraft(s, { kind: 'command', command: '  ' });
    expect(w.validateServer.bind(undefined, english)(s, catalog)?.field).toBe('command');
    s = w.patchDraft(s, { command: 'npx -y some-mcp-server' });
    expect(w.validateServer.bind(undefined, english)(s, catalog)).toBeUndefined();
  });

  it('asks a catalog service only for what its sign-in needs', () => {
    const bearer = catalog.connectors.find((c) => c.auth.type === 'bearer')!.id;
    const own = catalog.connectors.find((c) => c.auth.type === 'oauth-client')!.id;
    expect(authOf(bearer)).toBe('bearer');
    const token = w.chooseServer(w.startAddServer(), bearer, catalog);
    expect(w.validateServer.bind(undefined, english)(token, catalog)?.field).toBe('token');
    expect(w.validateServer.bind(undefined, english)(token, catalog, { token: true })).toBeUndefined();
    const client = w.chooseServer(w.startAddServer(), own, catalog);
    expect(w.validateServer.bind(undefined, english)(client, catalog, {})?.field).toBe('clientId');
    expect(
      w.validateServer.bind(undefined, english)(w.patchDraft(client, { clientId: 'abc' }), catalog),
    ).toBeUndefined();
    expect(
      w.validateServer.bind(undefined, english)(w.chooseServer(w.startAddServer(), 'linear', catalog), catalog),
    ).toBeUndefined();
  });

  it('builds the request for a server of your own, with the token only when one was typed', () => {
    let s = w.patchDraft(w.chooseServer(w.startAddServer(), 'custom', catalog), {
      name: 'docs-search',
      url: 'https://docs.internal.example/mcp',
      description: ' Internal docs ',
      exposure: 'deferred',
    });
    expect(w.connectRequest(s, catalog)).toEqual({
      id: 'custom',
      scope: 'user',
      exposure: 'deferred',
      custom: { name: 'docs-search', url: 'https://docs.internal.example/mcp', description: 'Internal docs' },
    });
    expect(w.connectRequest(s, catalog, { token: 'abc' })).toMatchObject({ token: 'abc', scope: 'user' });
    s = w.patchDraft({ ...s, scope: 'project' }, {});
    expect(w.connectRequest(s, catalog)?.scope).toBe('project');
    // a credential never goes into the project file
    expect(w.connectRequest(s, catalog, { token: 'abc' })?.scope).toBe('user');
    s = w.patchDraft(s, { kind: 'command', command: 'node "/a b/server.js" --x' });
    expect(w.connectRequest(s, catalog)?.custom).toEqual({
      name: 'docs-search',
      command: 'node',
      args: ['/a b/server.js', '--x'],
      description: 'Internal docs',
    });
    expect(w.connectRequest(s, catalog, { token: 'abc' })).not.toHaveProperty('token');
  });

  it('builds the request for a catalog service', () => {
    const s = w.chooseServer({ ...w.startAddServer(), scope: 'project' }, 'linear', catalog);
    expect(w.connectRequest(s, catalog)).toMatchObject({ id: 'linear', scope: 'project' });
    const bearer = catalog.connectors.find((c) => c.auth.type === 'bearer')!.id;
    const b = w.chooseServer({ ...w.startAddServer(), scope: 'project' }, bearer, catalog);
    expect(w.connectRequest(b, catalog, { token: 't' })).toMatchObject({ id: bearer, scope: 'user', token: 't' });
    expect(w.connectRequest(w.startAddServer(), catalog)).toBeUndefined();
  });

  it('offers "This project only" where a project file can hold the server', () => {
    const bearer = catalog.connectors.find((c) => c.auth.type === 'bearer')!.id;
    expect(w.projectAllowed('linear', catalog, true)).toBe(true);
    expect(w.projectAllowed('linear', catalog, false)).toBe(false);
    expect(w.projectAllowed(bearer, catalog, true)).toBe(false);
    expect(w.projectAllowed('custom', catalog, true)).toBe(true);
  });

  it('labels the primary button for what it will do', () => {
    expect(w.primaryText.bind(undefined, english)(w.startAddServer(), catalog)).toBe('Continue');
    expect(w.primaryText.bind(undefined, english)(w.chooseServer(w.startAddServer(), 'linear', catalog), catalog)).toBe(
      'Add and sign in',
    );
    expect(w.primaryText.bind(undefined, english)(w.chooseServer(w.startAddServer(), 'custom', catalog), catalog)).toBe(
      'Add and connect',
    );
  });
});
