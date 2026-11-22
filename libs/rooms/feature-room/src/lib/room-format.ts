import { Injectable, inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import type { PlaybookTriggerState } from '@pi-kit/protocol';

@Injectable({ providedIn: 'root' })
export class RoomFormat {
  private readonly language = inject(Language);

  when(trigger: PlaybookTriggerState): string {
    const every = trigger.cron ?? this.language.t('rooms.playbook.every', { value1: trigger.every ?? '' });
    return trigger.tool ? `${every} · ${trigger.tool}` : every;
  }

  time(at: number): string {
    return new Date(at).toLocaleString(this.language.locale(), {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  duration(start: number, end: number | null): string {
    if (end === null) return this.language.t('rooms.runs.ongoing');
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 1) return '<1s';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
}
