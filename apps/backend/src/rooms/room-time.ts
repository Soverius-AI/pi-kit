/** Room-local time, including daylight-saving transitions. */
export class RoomTime {
  private static readonly formats = new Map<string, Intl.DateTimeFormat>();

  private static format(timezone: string, clock: boolean): Intl.DateTimeFormat {
    const key = `${timezone}:${clock}`;
    const existing = this.formats.get(key);
    if (existing) return existing;
    const format = new Intl.DateTimeFormat(clock ? 'en-GB' : 'en-CA', {
      timeZone: timezone,
      ...(clock
        ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
        : { year: 'numeric', month: '2-digit', day: '2-digit' }),
    });
    if (this.formats.size >= 128) this.formats.delete(this.formats.keys().next().value as string);
    this.formats.set(key, format);
    return format;
  }

  static clock(at: number, timezone: string): string {
    return this.format(timezone, true).format(at);
  }

  static day(at: number, timezone: string): string {
    const parts = this.format(timezone, false).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  static quiet(at: number, timezone: string, start: string | null, end: string | null): boolean {
    if (!start || !end || start === end) return false;
    const clock = this.clock(at, timezone);
    return start < end ? clock >= start && clock < end : clock >= start || clock < end;
  }

  /** Once per calendar day. A skipped spring time runs at the first valid minute after it. */
  static nextDaily(time: string, timezone: string, after: number): number {
    const from = Math.floor(after / 60000) * 60000 + 60000;
    const day = this.day(after, timezone);
    const todayStillDue = time > this.clock(after, timezone);
    for (let at = from; at < from + 49 * 3600000; at += 60000) {
      const candidateDay = this.day(at, timezone);
      if ((candidateDay > day || (candidateDay === day && todayStillDue)) && this.clock(at, timezone) >= time)
        return at;
    }
    throw new Error('Could not determine the next local daily time.');
  }
}
