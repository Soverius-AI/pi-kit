import type { BaseEvent } from '@ag-ui/core';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Replay events use database-generated IDs; gaps between a thread's events are harmless to its cursor. */
export const threadEvents = sqliteTable('thread_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  threadId: text('thread_id').notNull(),
  runId: text('run_id'),
  event: text('event_json', { mode: 'json' }).$type<BaseEvent>().notNull(),
  type: text('type').notNull(),
});

/** The durable run locks. The SQL schema (`migrations/0001_init.sql`) owns the partial unique index and the status constraint. */
export const runRecords = sqliteTable('runs', {
  runId: text('run_id').primaryKey().notNull(),
  threadId: text('thread_id').notNull(),
  status: text('status', { enum: ['running', 'finished', 'error', 'aborted'] }).notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
});
