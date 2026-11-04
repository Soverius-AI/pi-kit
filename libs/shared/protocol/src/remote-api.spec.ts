import { describe, expect, it } from 'vitest';
import { isRemoteApiPath, isReviewedRemoteApi } from './remote-api';
import { REMOTE_ROUTES } from './remote-routes.generated';

describe('isReviewedRemoteApi', () => {
  it('admits the generated routes with any parameter segment', () => {
    for (const [method, template] of REMOTE_ROUTES) {
      const path = template.replace(/\{[^}]+\}/g, 'a.b-c_d');
      if (path.startsWith('/api/settings/')) continue;
      expect(isReviewedRemoteApi(path, method), `${method} ${path}`).toBe(true);
    }
  });

  it('keeps the hand rules outside the contract', () => {
    expect(isReviewedRemoteApi('/api/settings/thread', 'PUT')).toBe(true);
    expect(isReviewedRemoteApi('/api/settings/other', 'PUT')).toBe(false);
    expect(isReviewedRemoteApi('/api/agui', 'POST')).toBe(true);
    expect(isReviewedRemoteApi('/api/copilotkit/info', 'GET')).toBe(true);
    expect(isReviewedRemoteApi('/api/agui', 'DELETE')).toBe(false);
    expect(isReviewedRemoteApi('/api/agui/mcp-sandbox', 'GET')).toBe(false);
    expect(isReviewedRemoteApi('/api/threads/x/browser/tabs', 'GET')).toBe(false);
    expect(isReviewedRemoteApi('/api/threads/x/mcp-app1', 'GET')).toBe(false);
    expect(isReviewedRemoteApi('/api/instances/x/proxy/api/workspaces', 'GET')).toBe(false);
    expect(isReviewedRemoteApi('/api/peer/status', 'GET')).toBe(false);
    expect(isReviewedRemoteApi('/api/health', 'HEAD')).toBe(false);
  });

  it('rejects raw paths with traversal or control characters', () => {
    expect(isRemoteApiPath('/api/threads/a%2Fb')).toBe(true);
    expect(isRemoteApiPath('/api/threads/../x')).toBe(false);
    expect(isRemoteApiPath('/api/threads/%00')).toBe(false);
    expect(isRemoteApiPath('/apix/threads')).toBe(false);
  });
});
