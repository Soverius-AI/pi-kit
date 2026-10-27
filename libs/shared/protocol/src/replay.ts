/** Opaque per-backend log generation and sequence, used only with the matching cached transcript. */
export const REPLAY_CURSOR_HEADER = 'x-pi-kit-replay-cursor';
export const REPLAY_CURSOR_METADATA = 'piKitReplayCursor';
export const REPLAY_RESET_EVENT = 'pi.replay';
export const REPLAY_CHECKPOINT_EVENT = 'pi.replay.checkpoint';
/** Opt in to a current-state transfer, followed only by events produced after that transfer. */
export const THREAD_HYDRATION_HEADER = 'x-pi-kit-hydrate';
export const THREAD_HYDRATION_EVENT = 'pi.thread.hydrate';

export interface ThreadHydrationView {
  thinkTimes: Record<string, { start?: number; end?: number }>;
  queue: { steering: string[]; followUp: string[] };
  compacting: boolean;
  retry: { attempt: number; maxAttempts: number; reason: string } | undefined;
  runError: { message: string; code?: string } | undefined;
  lastAborted: boolean;
  statuses: Record<string, string>;
  liveContextTokens: number | undefined;
  /** Includes a suspended pi prompt whose AG-UI feed has already ended at an interrupt. */
  promptActive?: boolean;
}

/** Generic message type keeps the wire contract independent of a particular AG-UI client. */
export interface ThreadHydration<TMessage = unknown> {
  messages: TMessage[];
  state: unknown;
  /** A live feed remains open after this snapshot; idle hydration must finish its lifecycle before sending. */
  running?: boolean;
  view: ThreadHydrationView;
  composers: import('./composer').ComposerRegistration[];
  title?: string;
}
