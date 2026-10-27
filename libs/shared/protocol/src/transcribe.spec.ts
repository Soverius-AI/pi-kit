import { describe, expect, it } from 'vitest';
import { createSseParser, emptyTranscript, mergePartial, transcriptText, TranscribeStreamEventSchema, type SseMessage } from './transcribe';

describe('mergePartial (the live text of a streaming transcription)', () => {
  it('appends committed words with a space and replaces the pending tail every time', () => {
    let so = emptyTranscript();
    so = mergePartial(so, { text: '', pending: 'Please add a unit test.' });
    expect(transcriptText(so)).toBe('Please add a unit test.');
    so = mergePartial(so, { text: 'Please add a unit', pending: 'test for the parserend.' });
    expect(transcriptText(so)).toBe('Please add a unit test for the parserend.');
    so = mergePartial(so, { text: 'test for the', pending: 'parser and run the build.' });
    expect(transcriptText(so)).toBe('Please add a unit test for the parser and run the build.');
    so = mergePartial(so, { text: 'parser and run the build.', pending: '' });
    expect(transcriptText(so)).toBe('Please add a unit test for the parser and run the build.');
    expect(so.committed).toEqual(['Please add a unit', 'test for the', 'parser and run the build.']);
  });

  it('does not mutate the state it was given, ignores blanks and attaches punctuation to the word before it', () => {
    const first = mergePartial(emptyTranscript(), { text: '  hello ', pending: ' ' });
    const second = mergePartial(first, { text: '   ', pending: ', world' });
    expect(first.committed).toEqual(['hello']);
    expect(second.committed).toEqual(['hello']);
    expect(transcriptText(second)).toBe('hello, world');
    expect(transcriptText(emptyTranscript())).toBe('');
  });
});

describe('createSseParser', () => {
  const collect = (chunks: string[], end = true): SseMessage[] => {
    const out: SseMessage[] = [];
    const parser = createSseParser((m) => out.push(m));
    for (const chunk of chunks) parser.push(chunk);
    if (end) parser.end();
    return out;
  };

  it('reads events however the body is cut into chunks', () => {
    const body = 'event: partial\ndata: {"a":1}\n\nevent: done\ndata: {"b":2}\n\n';
    const whole = collect([body]);
    expect(whole).toEqual([
      { event: 'partial', data: '{"a":1}' },
      { event: 'done', data: '{"b":2}' },
    ]);
    // Cut at every position: the same two events come out.
    for (let i = 1; i < body.length; i++) expect(collect([body.slice(0, i), body.slice(i)])).toEqual(whole);
    expect(collect(body.split(''))).toEqual(whole);
  });

  it('handles CRLF (even split between the two bytes), comments, default event name and multi-line data', () => {
    const body = ': keep-alive\r\ndata: one\r\ndata: two\r\n\r\nevent: x\r\ndata: y\r\n\r\n';
    const expected = [
      { event: 'message', data: 'one\ntwo' },
      { event: 'x', data: 'y' },
    ];
    expect(collect([body])).toEqual(expected);
    for (let i = 1; i < body.length; i++) expect(collect([body.slice(0, i), body.slice(i)])).toEqual(expected);
  });

  it('delivers an event only when its blank line arrives, and flushes the last one at the end of the body', () => {
    expect(collect(['event: done\ndata: {}\n'], false)).toEqual([]);
    expect(collect(['event: done\ndata: {}\n'])).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('carries the stream events the backend sends', () => {
    const [message] = collect(['event: partial\ndata: {"type":"partial","text":"hi","pending":"there","receivedSeconds":1}\n\n']);
    expect(TranscribeStreamEventSchema.parse(JSON.parse(message.data))).toEqual({ type: 'partial', text: 'hi', pending: 'there', receivedSeconds: 1 });
  });
});
