import { describe, expect, it } from 'vitest';
import { presentPhonePrompt } from './room-phone.presenter';

describe('provider-sized phone prompts', () => {
  it('fits an entire addressed Telegram approval and refuses to expose a token for an oversized preview', () => {
    const token = 'fixed-token';
    const exact = presentPhonePrompt('action', 'X'.repeat(3840), token, 100, '/', '_', '@RoomsAssistantBot', 4096);
    expect(exact.consumed).toBe(false);
    expect(exact.text.length).toBeLessThanOrEqual(4096);
    expect(exact.text).toContain(`/approve@RoomsAssistantBot ${token}`);
    expect(exact.text).toContain(`/reject@RoomsAssistantBot ${token}`);
    for (const kind of ['action', 'question'] as const) {
      const large = presentPhonePrompt(kind, 'X'.repeat(3841), token, 100, '/', '_', '@RoomsAssistantBot', 4096);
      expect(large.consumed).toBe(true);
      expect(large.text.length).toBeLessThanOrEqual(4096);
      expect(large.text).not.toContain(token);
      expect(large.text).not.toMatch(/\/(?:approve|answer)/);
    }
  });
  it('uses native addressed command names without changing the preview text', () => {
    const text = 'Keep /room-test in this quoted source text.';
    const test = presentPhonePrompt('test', text, 'token', 100, '/', '_', '@RoomsAssistantBot', 4096);
    expect(test.text).toContain(text);
    expect(test.text).toContain('Reply /room_test@RoomsAssistantBot token');
    const question = presentPhonePrompt('question', 'Question', 'token', 100, '/', '_', '@RoomsAssistantBot', 4096);
    expect(question.text).toContain('Reply /answer@RoomsAssistantBot token YOUR_ANSWER');
  });
});
