import { english } from '@pi-kit/i18n/testing';
import { forkMeta } from './fork-meta';

describe('forkMeta', () => {
  it('words the sidebar meta', () => {
    expect(forkMeta(english, 0)).toBeUndefined();
    expect(forkMeta(english, 1)).toBe('1 fork');
    expect(forkMeta(english, 3)).toBe('3 forks');
  });
});
