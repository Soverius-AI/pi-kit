import type { RoomChannelStatus, RoomPhoneStatus } from '@pi-kit/protocol';
import type { PhoneMessage } from './room-phone.types';

/** Provider I/O only. Authorization, durable work and delivery retries belong to RoomPhoneService. */
export interface RoomMessagingTransport {
  phase: RoomPhoneStatus['connection'];
  qr: string | null;
  error: string | null;
  readonly input: NonNullable<RoomPhoneStatus['input']>;
  readonly account: string | undefined;
  readonly commandPrefix?: string;
  readonly commandSeparator?: '_' | '-';
  readonly commandSuffix?: string;
  readonly entryCommand?: string;
  readonly maxMessageLength?: number;
  /** True only when a reserved provider ID makes an uncertain send safe to replay. */
  readonly retryStableSends?: boolean;
  receive: (message: PhoneMessage) => Promise<void>;
  receipt: (id: string, status: number, group: string) => Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  createMessageId(): string;
  send(group: string, text: string, id?: string, quote?: { id: string; sender: string; text: string }): Promise<string>;
  media(raw: string): Promise<Uint8Array>;
  configure?(values: Record<string, string>): Promise<void>;
  details?(): Pick<RoomChannelStatus, 'configured' | 'dependency' | 'identity'>;
}
