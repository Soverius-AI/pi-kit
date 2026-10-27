import { describe, expect, it } from 'vitest';
import { answerLine, answerText, forwarded, isOpen, lastAnswer, newQuestion, openQuestion, refusal, routed, settled, toDialog, toQuestion } from './questions';

const now = 1_000_000;
const main = newQuestion('q1', 'call-1', { question: 'Must mul accept bigint?', kind: 'main', choices: ['yes', 'no'] }, now);
const user = newQuestion('q2', 'call-2', { question: 'Change greet?', kind: 'user' }, now);

describe('question records', () => {
  it('starts pending, is routed once delivered, and settles by answer or dismissal', () => {
    expect(main).toMatchObject({ state: 'pending', kind: 'main', choices: ['yes', 'no'], note: null, forwarded: false });
    expect(isOpen(routed(main))).toBe(true);
    expect(settled(routed(main), 'main', 'no', now + 5)).toMatchObject({ state: 'answered', by: 'main', answer: 'no', answeredAt: now + 5 });
    expect(settled(main, 'cancelled', null, now)).toMatchObject({ state: 'cancelled', by: 'cancelled', answer: null });
  });

  it('the main agent can answer its own questions but never the user\'s, and nothing settled is answered again', () => {
    expect(refusal(main, 'main')).toBeUndefined();
    expect(refusal(user, 'main')).toContain('for the user');
    expect(refusal(user, 'user')).toBeUndefined();
    expect(refusal(forwarded(main, ' Your call. '), 'main')).toContain('forwarded');
    expect(forwarded(main, undefined)).toMatchObject({ kind: 'user', forwarded: true, note: null });
    expect(refusal(settled(main, 'main', 'no', now), 'user')).toContain('already answered');
  });

  it('finds the one open question and the newest answer, and shows a user question as a dialog of the thread', () => {
    const questions = { q1: settled(main, 'main', 'no', now + 1), q2: routed(user) };
    expect(openQuestion(questions)?.id).toBe('q2');
    expect(lastAnswer(questions)).toEqual({ question: 'Must mul accept bigint?', text: 'no', by: 'main', answeredAt: now + 1 });
    expect(lastAnswer({})).toBeNull();
    expect(toDialog({ id: '7', name: 'reviewer' }, forwarded(main, 'Your call.'))).toEqual({
      id: 'agent-question:7:q1',
      agentId: '7',
      request: { method: 'select', title: 'Must mul accept bigint?', message: 'Your call.', options: ['yes', 'no'], agent: 'reviewer', toolCallId: 'call-1' },
    });
    const legacy = { ...user, default: 'no', expiresAt: now + 60_000 };
    expect(toDialog({ id: '7', name: 'reviewer' }, legacy).request).toMatchObject({ method: 'input' });
    expect(toDialog({ id: '7', name: 'reviewer' }, legacy).request.expiresAt).toBeUndefined();
    expect(toQuestion(legacy).expiresAt).toBeNull();
    expect(answerText({ value: 'Keep it' })).toBe('Keep it');
    expect(answerText({ confirmed: false })).toBe('no');
    expect(answerLine(settled(main, 'main', 'No, numbers only.', now))).toBe('Answered by main agent: No, numbers only.');
    expect(answerLine(settled(main, 'user', 'Keep it', now))).toBe('Answered by the user: Keep it');
    expect(answerLine({ ...user, state: 'answered', by: 'default', answer: 'no', answeredAt: now })).toContain('default applies: no');
    expect(answerLine({ ...main, state: 'expired', by: 'expired', answeredAt: now })).toContain('Decide yourself');
    expect(answerLine(settled(main, 'cancelled', null, now))).toContain('dismissed');
  });
});
