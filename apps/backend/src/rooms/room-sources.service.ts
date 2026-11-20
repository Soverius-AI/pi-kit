import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { PlaybookCalendarSource, PlaybookMailSource } from '@pi-kit/protocol';
import { resolveConfigValue } from '../pi/mcp-transport';
import type { ToolRun } from './room-playbook-tools.service';

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  calendar: string | null;
  recurring: boolean;
  timeZone: string;
}

@Injectable()
export class RoomSources {
  static readonly TIMEOUT = 120_000;

  private static readonly MAIL = `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const Mail = Application('Mail');
  if (!Mail.running() && !o.launch) throw new Error('Mail is not open on this computer.');
  let box = Mail.inbox;
  if (o.mailbox.toLowerCase() !== 'inbox') {
    box = null;
    for (const account of Mail.accounts()) {
      try { const found = account.mailboxes.byName(o.mailbox); found.name(); box = found; break; } catch (e) {}
    }
    if (!box) throw new Error('Mail has no mailbox named ' + o.mailbox + '.');
  }
  const messages = o.unread ? box.messages.whose({ readStatus: false }) : box.messages;
  const dates = messages.dateReceived();
  const order = dates.map((date, index) => [date ? date.getTime() : 0, index]).sort((a, b) => b[0] - a[0]).slice(0, o.limit);
  return JSON.stringify(order.map(([, index]) => {
    const m = messages[index];
    let preview = '';
    try { preview = (m.content() || '').replace(/\\s+/g, ' ').slice(0, 400); } catch (e) {}
    return { id: m.messageId(), from: m.sender(), subject: m.subject(), received: m.dateReceived().toISOString(), unread: !m.readStatus(), preview };
  }));
}`;

  private static readonly CALENDAR = `
ObjC.import('EventKit');
function run(argv) {
  const o = JSON.parse(argv[0]);
  const store = $.EKEventStore.alloc.init;
  let status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
  if (status === 0) {
    let done = false;
    const answered = () => { done = true; };
    if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) store.requestFullAccessToEventsWithCompletion(answered);
    else store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, answered);
    const until = Date.now() + 90000;
    while (!done && Date.now() < until) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
    status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
  }
  if (status !== 3) throw new Error('pi-kit may not read the calendars of this computer. Allow it in System Settings, Privacy & Security, Calendars.');
  const start = $.NSDate.date;
  const end = $.NSDate.dateWithTimeIntervalSinceNow(o.days * 86400);
  const events = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(start, end, $()));
  const text = (value) => (value && !value.isNil() ? value.js : null);
  const out = [];
  for (let i = 0; i < events.count; i++) {
    const e = events.objectAtIndex(i);
    const begins = e.startDate.timeIntervalSince1970 * 1000;
    out.push({
      id: (text(e.calendarItemExternalIdentifier) || text(e.eventIdentifier) || '') + '@' + begins,
      title: text(e.title) || '',
      start: begins,
      end: e.endDate.isNil() ? null : e.endDate.timeIntervalSince1970 * 1000,
      allDay: !!e.allDay,
      location: text(e.location),
      calendar: e.calendar.isNil() ? null : text(e.calendar.title),
      recurring: !!e.hasRecurrenceRules,
    });
  }
  return JSON.stringify(out);
}`;

  async mail(options: PlaybookMailSource): Promise<ToolRun> {
    if (process.platform !== 'darwin') return { ok: false, output: 'Local mail works with Mail on a Mac for now.' };
    return await this.osascript(RoomSources.MAIL, options);
  }

  async calendar(cwd: string, options: PlaybookCalendarSource): Promise<ToolRun> {
    if (options.ics) {
      try {
        const source = resolveConfigValue(options.ics, 'The calendar');
        const text = /^https?:\/\//.test(source)
          ? await this.fetchText(source)
          : await readFile(isAbsolute(source) ? source : resolve(cwd, source), 'utf8');
        const from = Date.now();
        return { ok: true, output: JSON.stringify(this.ics(text, from, from + options.days * 86_400_000)) };
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error) };
      }
    }
    if (process.platform !== 'darwin')
      return { ok: false, output: 'This computer’s calendars work on a Mac; elsewhere give the calendar an ics URL.' };
    const read = await this.osascript(RoomSources.CALENDAR, { days: options.days });
    if (!read.ok) return read;
    const events = JSON.parse(read.output) as (Omit<CalendarEvent, 'start' | 'end'> & {
      start: number;
      end: number | null;
    })[];
    return {
      ok: true,
      output: JSON.stringify(
        events.map((event) => ({
          ...event,
          start: this.local(event.start),
          end: event.end === null ? null : this.local(event.end),
          timeZone: this.zone(),
        })),
      ),
    };
  }

  ics(text: string, from: number, to: number): CalendarEvent[] {
    const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const events: CalendarEvent[] = [];
    let current: Record<string, string> | undefined;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') current = {};
      else if (line === 'END:VEVENT' && current) {
        const start = current['DTSTART'] && this.icsDate(current['DTSTART']);
        const end = current['DTEND'] && this.icsDate(current['DTEND']);
        if (start && start.at < to && (end ? end.at : start.at) >= from)
          events.push({
            id: `${current['UID'] ?? ''}@${start.at}`,
            title: this.icsText(current['SUMMARY'] ?? ''),
            start: this.local(start.at),
            end: end ? this.local(end.at) : null,
            timeZone: this.zone(),
            allDay: start.allDay,
            location: current['LOCATION'] ? this.icsText(current['LOCATION']) : null,
            calendar: null,
            recurring: !!current['RRULE'],
          });
        current = undefined;
      } else if (current) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).split(';')[0] ?? '';
        current[name.toUpperCase()] ??= line.slice(colon + 1);
      }
    }
    return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  private local(at: number): string {
    const date = new Date(at);
    const offset = -date.getTimezoneOffset();
    const pad = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset < 0 ? '-' : '+'}${pad(offset / 60)}:${pad(offset % 60)}`;
  }

  private zone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  protected async osascript(script: string, input: unknown): Promise<ToolRun> {
    return await new Promise((done) => {
      execFile(
        'osascript',
        ['-l', 'JavaScript', '-e', script, JSON.stringify(input)],
        { timeout: RoomSources.TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) =>
          done(
            error
              ? { ok: false, output: (stderr || error.message).replace(/^.*execution error: /, '').trim() }
              : { ok: true, output: stdout.trim() },
          ),
      );
    });
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`The calendar answered ${response.status}.`);
    return await response.text();
  }

  private icsDate(value: string): { at: number; allDay: boolean } | undefined {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
    if (!match) return undefined;
    const [, y, mo, d, h, mi, s, utc] = match.map((part) => part ?? '');
    if (!h) return { at: new Date(Number(y), Number(mo) - 1, Number(d)).getTime(), allDay: true };
    const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
    return { at: utc ? Date.UTC(...parts) : new Date(...parts).getTime(), allDay: false };
  }

  private icsText(value: string): string {
    return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === 'n' || char === 'N' ? '\n' : char));
  }
}
