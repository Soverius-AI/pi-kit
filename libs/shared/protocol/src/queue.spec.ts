import { describe, expect, it } from 'vitest';
import { mergeQueue } from './queue';

describe('mergeQueue', () => {
  it('joins steering then follow-ups into one steer, in delivery order', () => {
    expect(mergeQueue({ steering: ['a', 'b'], followUp: ['c'] })).toEqual({ kind: 'steer', text: 'a\n\nb\n\nc' });
  });
  it('keeps a queue of follow-ups a follow-up', () => {
    expect(mergeQueue({ steering: [], followUp: ['x', 'y'] })).toEqual({ kind: 'followUp', text: 'x\n\ny' });
  });
  it('has nothing to merge in an empty queue', () => {
    expect(mergeQueue({ steering: [], followUp: [] })).toBeUndefined();
  });
});
