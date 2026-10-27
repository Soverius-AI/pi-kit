import { english } from '@pi-kit/i18n/testing';
import { describe, expect, it } from 'vitest';
import { a2uiCardHeader, mcpToolLabel } from './genui';

describe('a2uiCardHeader', () => {
  it('reads title, badge and tone from the root card', () => {
    expect(a2uiCardHeader(english, { title: 'Failing specs', badge: '3', badgeTone: 'error' })).toEqual({
      title: 'Failing specs',
      badge: '3',
      tone: 'error',
    });
  });

  it('falls back to a generic title, and ignores a tone it does not know or a title that is not a string', () => {
    expect(a2uiCardHeader(english, { title: { path: '/t' }, badge: '1', badgeTone: 'purple' })).toEqual({
      title: 'Generated UI',
      badge: '1',
      tone: 'neutral',
    });
    expect(a2uiCardHeader(english, { title: '  ', badge: '' })).toEqual({ title: 'Generated UI', tone: 'neutral' });
    expect(a2uiCardHeader(english, {})).toEqual({ title: 'Generated UI', tone: 'neutral' });
    expect(a2uiCardHeader(english, undefined)).toEqual({ title: 'Generated UI', tone: 'neutral' });
  });
});

describe('mcpToolLabel', () => {
  it('turns a tool name into a phrase', () => {
    expect(mcpToolLabel('open_issue_form')).toBe('open issue form');
    expect(mcpToolLabel('create-issue')).toBe('create issue');
    expect(mcpToolLabel(undefined)).toBeUndefined();
    expect(mcpToolLabel('')).toBeUndefined();
  });
});
