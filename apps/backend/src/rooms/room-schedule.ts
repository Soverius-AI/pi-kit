export class RoomSchedule {
  private static readonly RANGES: readonly (readonly [number, number])[] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];

  static valid(cron: string): boolean {
    try {
      RoomSchedule.fields(cron.trim().split(/\s+/));
      return true;
    } catch {
      return false;
    }
  }

  static matches(cron: string, at: Date): boolean {
    const parts = cron.trim().split(/\s+/);
    const [minute, hour, day, month, weekday] = RoomSchedule.fields(parts);
    const dayOk = day.has(at.getDate());
    const weekOk = weekday.has(at.getDay()) || (at.getDay() === 0 && weekday.has(7));
    const dayPart = parts[2] !== '*' && parts[4] !== '*' ? dayOk || weekOk : dayOk && weekOk;
    return minute.has(at.getMinutes()) && hour.has(at.getHours()) && month.has(at.getMonth() + 1) && dayPart;
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
