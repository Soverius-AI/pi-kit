import { describe, expect, it } from 'vitest';
import { a2uiOperationsOf, isProxiedMcpRun, mcpServerHash, proxiedMcpRequestOf, uiResourceUriOf } from './genui';

const ops = [{ version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'c' } }];

describe('a2uiOperationsOf', () => {
  it('reads details.a2ui_operations', () => {
    expect(a2uiOperationsOf({ details: { a2ui_operations: ops } })).toEqual(ops);
  });
  it('reads the AG-UI container from a result text, also when it is a JSON string of JSON', () => {
    expect(a2uiOperationsOf({ text: JSON.stringify({ a2ui_operations: ops }) })).toEqual(ops);
    expect(a2uiOperationsOf({ text: JSON.stringify(JSON.stringify({ a2ui_operations: ops })) })).toEqual(ops);
  });
  it('ignores anything else', () => {
    expect(a2uiOperationsOf({ text: 'hello' })).toBeUndefined();
    expect(a2uiOperationsOf({ text: '{"a2ui_operations": []}' })).toBeUndefined();
    expect(a2uiOperationsOf({ text: '{not json' })).toBeUndefined();
    expect(a2uiOperationsOf({ details: { a2ui_operations: 'x' } })).toBeUndefined();
    expect(a2uiOperationsOf({ details: ['a2ui_operations'] })).toBeUndefined();
  });
});

describe('uiResourceUriOf', () => {
  it('reads both spellings and only ui:// URIs', () => {
    expect(uiResourceUriOf({ ui: { resourceUri: 'ui://a/b' } })).toBe('ui://a/b');
    expect(uiResourceUriOf({ 'ui/resourceUri': 'ui://a/c' })).toBe('ui://a/c');
    expect(uiResourceUriOf({ ui: { resourceUri: 'https://a' } })).toBeUndefined();
    expect(uiResourceUriOf(undefined)).toBeUndefined();
    expect(uiResourceUriOf({ ui: 'x' })).toBeUndefined();
  });
});

describe('proxied MCP requests', () => {
  it('recognises the forwarded prop and validates it', () => {
    const request = { serverHash: mcpServerHash('issues'), serverId: 'issues', method: 'tools/call', params: { name: 'x' } };
    expect(proxiedMcpRequestOf({ __proxiedMCPRequest: request })).toEqual(request);
    expect(proxiedMcpRequestOf({ __proxiedMCPRequest: { method: 1 } })).toBeUndefined();
    expect(proxiedMcpRequestOf({})).toBeUndefined();
    expect(proxiedMcpRequestOf(undefined)).toBeUndefined();
    // a malformed request is still a proxied run: it must never become a prompt
    expect(isProxiedMcpRun({ __proxiedMCPRequest: { method: 1 } })).toBe(true);
    expect(isProxiedMcpRun({ cwd: '/x' })).toBe(false);
  });
});
