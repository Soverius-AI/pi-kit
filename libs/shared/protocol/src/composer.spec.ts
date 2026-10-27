import { describe, expect, it } from 'vitest';
import { CompleteRequestSchema, ComposerRegistrationSchema, PutFeedbackSchema, parsePiCustomEvent } from './index';

describe('composer registrations', () => {
  it('accepts an action, a suggestion and a removal', () => {
    expect(ComposerRegistrationSchema.safeParse({ op: 'action', id: 'a', label: 'Say hello', icon: 'Hi', text: '/pk-hello ', send: false }).success).toBe(true);
    expect(ComposerRegistrationSchema.safeParse({ op: 'suggestion', id: 's', title: 'Ask', text: 'hello' }).success).toBe(true);
    expect(ComposerRegistrationSchema.safeParse({ op: 'remove', id: 'a' }).success).toBe(true);
  });

  it('rejects an unknown op, a missing field and a long icon', () => {
    expect(ComposerRegistrationSchema.safeParse({ op: 'toggle', id: 'a' }).success).toBe(false);
    expect(ComposerRegistrationSchema.safeParse({ op: 'action', id: 'a', text: 'x' }).success).toBe(false);
    expect(ComposerRegistrationSchema.safeParse({ op: 'action', id: 'a', label: 'x', icon: 'too long icon', text: 'x' }).success).toBe(false);
    expect(ComposerRegistrationSchema.safeParse({ op: 'remove', id: '' }).success).toBe(false);
  });

  it('is the value of the pi.composer custom event', () => {
    expect(parsePiCustomEvent({ name: 'pi.composer', value: { op: 'remove', id: 'a' } })).toEqual({ name: 'pi.composer', value: { op: 'remove', id: 'a' } });
    expect(parsePiCustomEvent({ name: 'pi.composer', value: { op: 'nope' } })).toBeUndefined();
  });
});

describe('feedback and completion requests', () => {
  it('allows null to clear a rating but not an empty message id', () => {
    expect(PutFeedbackSchema.safeParse({ messageId: 'm1', rating: null }).success).toBe(true);
    expect(PutFeedbackSchema.safeParse({ messageId: 'm1', rating: 'up' }).success).toBe(true);
    expect(PutFeedbackSchema.safeParse({ messageId: '', rating: 'up' }).success).toBe(false);
    expect(PutFeedbackSchema.safeParse({ messageId: 'm1', rating: 'meh' }).success).toBe(false);
  });

  it('wants a non-negative integer caret', () => {
    expect(CompleteRequestSchema.safeParse({ text: '/pk-fruit a', cursor: 11 }).success).toBe(true);
    expect(CompleteRequestSchema.safeParse({ text: 'x', cursor: -1 }).success).toBe(false);
    expect(CompleteRequestSchema.safeParse({ text: 'x', cursor: 1.5 }).success).toBe(false);
  });
});
