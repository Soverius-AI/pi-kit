export class RoomSchedule {
  private static readonly RANGES: readonly (readonly [number, number])[] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];

  /** How long an `every` such as 15m lasts, at least 30 seconds. */
  static duration(every: string): number {
    const value = Number.parseInt(every, 10);
    const unit = every.at(-1);
    return Math.max(
      30_000,
      value * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000),
    );
  }

  static valid(cron: string): boolean {
    try {
      RoomSchedule.fields(cron.trim().split(/\s+/));
      return true;
    } catch {
      return false;
    }
  }

  static matches(cron: string, at: Date): boolean {
    return RoomSchedule.matcher(cron)(at);
  }

  /** The first minute after `from` the cron matches, looking a month ahead. */
  static next(cron: string, from: number): number | undefined {
    const matches = RoomSchedule.matcher(cron);
    const start = Math.floor(from / 60_000) * 60_000 + 60_000;
    for (let at = start; at < start + 31 * 86_400_000; at += 60_000) if (matches(new Date(at))) return at;
    return undefined;
  }

  private static matcher(cron: string): (at: Date) => boolean {
    const parts = cron.trim().split(/\s+/);
    const [minute, hour, day, month, weekday] = RoomSchedule.fields(parts);
    return (at) => {
      const dayOk = day.has(at.getDate());
      const weekOk = weekday.has(at.getDay()) || (at.getDay() === 0 && weekday.has(7));
      const dayPart = parts[2] !== '*' && parts[4] !== '*' ? dayOk || weekOk : dayOk && weekOk;
      return minute.has(at.getMinutes()) && hour.has(at.getHours()) && month.has(at.getMonth() + 1) && dayPart;
    };
  }

  private static fields(parts: string[]): [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>] {
    if (parts.length !== 5) throw new Error('A cron schedule has five fields.');
    return RoomSchedule.RANGES.map(([low, high], index) => RoomSchedule.field(parts[index] ?? '', low, high)) as [
      Set<number>,
      Set<number>,
      Set<number>,
      Set<number>,
      Set<number>,
    ];
  }

  private static field(part: string, low: number, high: number): Set<number> {
    const values = new Set<number>();
    for (const item of part.split(',')) {
      const [range = '', stepText] = item.split('/');
      const step = stepText === undefined ? 1 : Number(stepText);
      const bounds =
        range === '*'
          ? [low, high]
          : range.includes('-')
            ? range.split('-').map(Number)
            : [Number(range), stepText === undefined ? Number(range) : high];
      const [from = Number.NaN, to = Number.NaN] = bounds;
      if (![from, to, step].every(Number.isInteger) || step < 1 || from < low || to > high || from > to)
        throw new Error(`The cron field ${part} is not valid.`);
      for (let value = from; value <= to; value += step) values.add(value);
    }
    return values;
  }
}
