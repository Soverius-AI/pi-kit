import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type BaseEvent, EventType } from '@ag-ui/core';
import { redact, type RoomLive as RoomLiveMessage } from '@pi-kit/protocol';
import { RoomBus } from './room-bus';

export interface LiveSpeaker {
  roomId: string;
  actor: RoomLiveMessage['actor'];
  role?: string;
  taskId?: string;
  environmentId?: string;
}

export interface LivePiece {
  text: string;
  reset: boolean;
  activity: string | null;
  done: boolean;
}

export interface LiveTurn {
  observe: (event: BaseEvent) => void;
  end: () => void;
}

export interface LiveRelay {
  put: (piece: LivePiece) => void;
  end: () => void;
}

export class LiveFeed {
  private text = '';
  private sent = 0;
  private restart = true;
  private started = false;
  private over = false;
  private activity: string | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly every: number,
    private readonly send: (piece: LivePiece) => void,
  ) {}

  readonly observe = (event: BaseEvent): void => {
    if (this.over) return;
    const raw = event as { delta?: unknown; toolCallName?: unknown };
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
        this.text = '';
        this.sent = 0;
        this.restart = true;
        this.activity = null;
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
        this.text += typeof raw.delta === 'string' ? raw.delta : '';
        this.activity = null;
        break;
      case EventType.TOOL_CALL_START:
        this.activity = typeof raw.toolCallName === 'string' ? raw.toolCallName : null;
        break;
      case EventType.TOOL_CALL_RESULT:
        this.activity = null;
        break;
      default:
        return;
    }
    this.timer ??= setTimeout(() => this.flush(), this.every);
    this.timer.unref?.();
  };

  end(): void {
    if (this.over) return;
    if (this.timer) clearTimeout(this.timer);
    this.over = true;
    if (this.started) this.send({ text: '', reset: false, activity: null, done: true });
  }

  private flush(): void {
    this.timer = undefined;
    if (this.over) return;
    const safe = redact(this.text);
    const whole = this.restart || safe !== this.text;
    this.send({
      text: whole ? safe : this.text.slice(this.sent),
      reset: whole,
      activity: this.activity,
      done: false,
    });
    this.sent = this.text.length;
    this.started = true;
    this.restart = false;
  }
}

@Injectable()
export class RoomLive {
  static readonly EVERY = 60;
  private readonly open = new Map<string, Map<string, RoomLiveMessage>>();

  constructor(private readonly bus: RoomBus) {}

  snapshot(roomId: string): RoomLiveMessage[] {
    return [...(this.open.get(roomId)?.values() ?? [])].map((message) => ({
      ...message,
      text: redact(message.text),
      reset: true,
    }));
  }

  turn(speaker: LiveSpeaker): LiveTurn {
    const relay = this.relay(speaker);
    const feed = new LiveFeed(RoomLive.EVERY, (piece) => (piece.done ? undefined : relay.put(piece)));
    return {
      observe: feed.observe,
      end: () => {
        feed.end();
        relay.end();
      },
    };
  }

  relay(speaker: LiveSpeaker): LiveRelay {
    const message: RoomLiveMessage = {
      id: randomUUID(),
      actor: speaker.actor,
      role: speaker.role ?? null,
      taskId: speaker.taskId ?? null,
      environmentId: speaker.environmentId ?? null,
      text: '',
      reset: true,
      activity: null,
      done: false,
    };
    const turns = this.open.get(speaker.roomId) ?? new Map<string, RoomLiveMessage>();
    turns.set(message.id, message);
    this.open.set(speaker.roomId, turns);
    this.bus.emit(speaker.roomId, { type: 'live', live: { ...message } });
    const close = (): void => {
      message.done = true;
      turns.delete(message.id);
      if (turns.size === 0) this.open.delete(speaker.roomId);
      this.bus.emit(speaker.roomId, { type: 'live', live: { ...message, text: '', reset: false, activity: null } });
    };
    return {
      put: (piece) => {
        if (message.done) return;
        message.text = piece.reset ? piece.text : message.text + piece.text;
        message.activity = piece.activity;
        if (piece.done) return close();
        this.bus.emit(speaker.roomId, { type: 'live', live: { ...message, text: piece.text, reset: piece.reset } });
      },
      end: () => {
        if (!message.done) close();
      },
    };
  }
}
