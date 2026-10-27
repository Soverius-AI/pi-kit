import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';
import { EventLogRepository } from './event-log.repository';
import { MetaRepository } from './meta.repository';
import { RedactionService } from './redaction.service';
import { TerminalReplayRepository } from './terminal-replay.repository';
import { ThreadsRepository } from './threads.repository';

const GITHUB = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const OPENAI = 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789a1b2';

function world() {
  const database = new DatabaseService({ dataDir: realpathSync(mkdtempSync(join(tmpdir(), 'pk-redact-'))) });
  const meta = new MetaRepository(database);
  const threads = new ThreadsRepository(database);
  const redaction = new RedactionService(meta, threads);
  const log = new EventLogRepository(database, redaction);
  threads.insertDraft({ id: 't1', sessionPath: '/s/t1.jsonl', cwd: '/projects/a' });
  threads.insertDraft({ id: 't2', sessionPath: '/s/t2.jsonl', cwd: '/projects/b' });
  return { database, meta, redaction, log };
}

describe('redaction before the replay log is written', () => {
  it('masks key shapes in every string of an event, keeps ids and types, and the original is nowhere in the database', () => {
    const { log, database } = world();
    log.append('t1', 'r1', { type: EventType.TOOL_CALL_RESULT, messageId: 'm1', toolCallId: 'c1', content: `remote: ${GITHUB}` } as never);
    log.append('t1', 'r1', { type: EventType.MESSAGES_SNAPSHOT, messages: [{ id: 'u1', role: 'user', content: `my key is ${OPENAI}, use it` }] } as never);
    const rows = log.read('t1');
    expect(rows[0].event).toEqual({ type: 'TOOL_CALL_RESULT', messageId: 'm1', toolCallId: 'c1', content: 'remote: [redacted github token …6789]' });
    expect((rows[1].event as unknown as { messages: { content: string }[] }).messages[0].content).toBe('my key is [redacted openai key …a1b2], use it');
    const raw = database.db.prepare('SELECT group_concat(event_json) AS all_json FROM thread_events').get() as { all_json: string };
    expect(raw.all_json).not.toContain(GITHUB);
    expect(raw.all_json).not.toContain(OPENAI);
  });

  it('is off for a folder the person switched it off for, and only for that folder', () => {
    const { log, redaction } = world();
    redaction.save({ patterns: [], offFor: ['/projects/b'] });
    log.append('t1', 'r1', { type: EventType.TOOL_CALL_RESULT, messageId: 'm', toolCallId: 'c', content: GITHUB } as never);
    log.append('t2', 'r1', { type: EventType.TOOL_CALL_RESULT, messageId: 'm', toolCallId: 'c', content: GITHUB } as never);
    expect((log.read('t1')[0].event as unknown as { content: string }).content).toContain('[redacted github token');
    expect((log.read('t2')[0].event as unknown as { content: string }).content).toBe(GITHUB);
  });

  it('applies the user’s patterns, reports the ones that are not valid, and keeps the configuration across a restart', () => {
    const { log, redaction, meta, database } = world();
    const saved = redaction.save({ patterns: [{ name: 'acme token', regex: 'acme_[a-z0-9]{12}' }, { name: 'broken', regex: '(' }], offFor: [] });
    expect(saved.errors).toHaveLength(1);
    expect(saved.errors[0]).toMatch(/^broken:/);
    log.append('t1', 'r1', { type: EventType.TOOL_CALL_RESULT, messageId: 'm', toolCallId: 'c', content: 'use acme_abcdef123456 now' } as never);
    expect((log.read('t1')[0].event as unknown as { content: string }).content).toBe('use [redacted acme token …3456] now');
    const restarted = new RedactionService(meta, new ThreadsRepository(database));
    expect(restarted.current().config.patterns.map((p) => p.name)).toEqual(['acme token', 'broken']);
  });

  it('leaves an event with nothing to mask as the same JSON it was', () => {
    const { log } = world();
    const event = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: 'Hello, world' };
    log.append('t1', 'r1', event as never);
    expect(log.read('t1')[0].event).toEqual(event);
  });
});

describe('the thread list', () => {
  it('keeps the first user message (the title’s fallback) with key shapes masked', () => {
    const { database } = world();
    const threads = new ThreadsRepository(database);
    threads.upsertFromSession({ id: 't9', sessionPath: '/s/t9.jsonl', cwd: '/projects/a', title: undefined, preview: `Use ${OPENAI} for the call`, messageCount: 1, createdAt: 1, updatedAt: 1, parentSessionPath: undefined } as never);
    expect(threads.get('t9')?.preview).toBe('Use [redacted openai key …a1b2] for the call');
    threads.recordRunEnd('t1', { logMtime: 1, messageCount: 2, preview: `again ${GITHUB}` });
    expect(threads.get('t1')?.preview).toBe('again [redacted github token …6789]');
  });
});

describe('redaction of what leaves through an export', () => {
  it('masks a session file line by line, unless the folder has it off', () => {
    const { redaction } = world();
    const file = `${JSON.stringify({ type: 'session', id: 'x' })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: OPENAI } })}\n`;
    const out = redaction.jsonl('/projects/a', file);
    expect(out.count).toBe(1);
    expect(out.text).not.toContain(OPENAI);
    expect(out.text).toContain('[redacted openai key …a1b2]');
    redaction.save({ patterns: [], offFor: ['/projects/a'] });
    expect(redaction.jsonl('/projects/a', file)).toEqual({ text: file, count: 0 });
  });

  it('masks the session data inside pi’s HTML export (base64 JSON in a script tag) and leaves the page alone', () => {
    const { redaction } = world();
    const data = Buffer.from(JSON.stringify({ entries: [{ type: 'message', message: { role: 'user', content: `token ${GITHUB}` } }] })).toString('base64');
    const html = `<html><head></head><body><script id="session-data" type="application/json">${data}</script><p>pi</p></body></html>`;
    const out = redaction.html('/projects/a', html);
    expect(out.count).toBe(1);
    const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(out.text)?.[1] as string;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    expect(decoded).toContain('[redacted github token …6789]');
    expect(decoded).not.toContain(GITHUB);
    expect(out.text).toContain('<p>pi</p>');
    const clean = html.replace(data, Buffer.from('{"entries":[]}').toString('base64'));
    expect(redaction.html('/projects/a', clean)).toEqual({ text: clean, count: 0 });
  });
});

describe('the terminal’s last screen', () => {
  it('is kept in the database and replaced on each save', () => {
    const { database } = world();
    const replay = new TerminalReplayRepository(database);
    expect(replay.get('/p')).toBeUndefined();
    replay.set('/p', 'first', 1);
    replay.set('/p', 'second', 2);
    expect(replay.get('/p')).toEqual({ data: 'second', updatedAt: 2 });
  });
});
