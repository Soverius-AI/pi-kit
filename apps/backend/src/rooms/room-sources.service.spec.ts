import { describe, expect, it, vi } from 'vitest';
import { RoomSchedule } from './room-schedule';
import { RoomSources } from './room-sources.service';

describe('room schedules', () => {
  it('matches cron fields with lists, ranges and steps', () => {
    expect(RoomSchedule.matches('0 8 * * 1-5', new Date(2026, 10, 23, 8, 0))).toBe(true);
    expect(RoomSchedule.matches('0 8 * * 1-5', new Date(2026, 10, 22, 8, 0))).toBe(false);
    expect(RoomSchedule.matches('*/15 9-17 * * *', new Date(2026, 10, 22, 12, 45))).toBe(true);
    expect(RoomSchedule.matches('*/15 9-17 * * *', new Date(2026, 10, 22, 12, 50))).toBe(false);
    expect(RoomSchedule.matches('0 0 1 * 0', new Date(2026, 10, 22, 0, 0))).toBe(true);
    expect(RoomSchedule.matches('0 0 * * 7', new Date(2026, 10, 22, 0, 0))).toBe(true);
    expect(RoomSchedule.valid('60 * * * *')).toBe(false);
    expect(RoomSchedule.valid('* * *')).toBe(false);
  });
});

describe('room sources', () => {
  it('reads folded lines and all-day events from iCalendar text', () => {
    const day = new Date(2026, 10, 23);
    const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
    const text = [
      'BEGIN:VEVENT',
      'UID:x',
      `DTSTART;VALUE=DATE:${stamp}`,
      'SUMMARY:A long',
      '  title',
      'RRULE:FREQ=WEEKLY',
      'END:VEVENT',
    ].join('\r\n');
    expect(new RoomSources().ics(text, day.getTime() - 1, day.getTime() + 86_400_000)).toEqual([
      expect.objectContaining({ title: 'A long title', allDay: true, recurring: true }),
    ]);
    const [event] = new RoomSources().ics(text, day.getTime() - 1, day.getTime() + 86_400_000);
    expect(event?.start).toMatch(/^2026-11-23T00:00:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(event?.start ?? '')).toBe(day.getTime());
    expect(event?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('asks Mail on a Mac with the playbook’s options and passes its JSON on', async () => {
    const sources = new RoomSources();
    const run = vi
      .spyOn(sources as unknown as { osascript: (script: string, input: unknown) => Promise<unknown> }, 'osascript')
      .mockResolvedValue({ ok: true, output: '[]' });
    const options = { mailbox: 'inbox', unread: true, limit: 5, launch: false };
    const result = await sources.mail(options);
    if (process.platform === 'darwin') {
      expect(result).toEqual({ ok: true, output: '[]' });
      expect(run).toHaveBeenCalledWith(expect.stringContaining("Application('Mail')"), options);
    } else expect(result.ok).toBe(false);
  });
});
