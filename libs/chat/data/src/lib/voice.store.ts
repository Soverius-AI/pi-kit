import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import type { CopilotChatAudioRecorder } from '@copilotkit/angular';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
  ApiClient,
  errorMessage,
  transcribeAbort,
  transcribeChunk,
  transcribeDownload,
  transcribeEnd,
  transcribeEvents,
  transcribeRecording,
  transcribeRemove,
  transcribeStartLive,
  transcribeStatus,
  unwrap,
} from '@pi-kit/api';
import {
  MIN_SPEECH_MS,
  type VoicePhase,
  encodeWav16,
  floatToPcm16Bytes,
  pushToTalk,
  releasesCombo,
  voiceHint,
} from '@pi-kit/chat/util';
import { DialogStore, IS_MAC, ToastStore, UiStore, ViewPrefs, withPersistence } from '@pi-kit/data-access';
import {
  SPEECH_LANGUAGES,
  type SpeechLanguage,
  type TranscribeLanguage,
  type TranscribeStatus,
  TranscribeStreamEventSchema,
  type TranscriptSoFar,
  emptyTranscript,
  mergePartial,
  transcriptText,
} from '@pi-kit/protocol';
import { eventMatches, formatCombo } from '@pi-kit/ui';
import { fromEvent, merge, tap } from 'rxjs';
import { ChatStore } from './chat.store';

import { type PcmTap, VoiceCapture } from './voice-capture';
import { VOICE_POLICY } from './voice-policy';

export type PttMode = 'hold' | 'toggle';

interface VoiceState {
  // ---- the user's choices (pi-kit's database, Settings › Voice)
  language: TranscribeLanguage;
  pttMode: PttMode;
  sendWhenDone: boolean;
  /** Send the speech to Whistle while it is being said and show the words in the hint row. */
  live: boolean;
  // ---- what is happening
  phase: VoicePhase;
  /** The recording was started with the push-to-talk key (the hint says "Release ⌥Space"), not with the button. */
  byKey: boolean;
  /** The words so far of a live recording. */
  partial: string;
  error: string | undefined;
  /** The well puts `copilot-chat-input` in transcribe mode only while a recording is wanted: CopilotKit's recorder then replaces the editor
   *  and its waveform canvas redraws every frame. */
  recorderWanted: boolean;
  // ---- the engine and the model, as the backend says
  status: TranscribeStatus | undefined;
  statusError: string | undefined;
  /** "Download Whistle" was clicked and the request has not answered yet. */
  requesting: boolean;
}

/** The choices of Settings › Voice. */
export type VoicePrefs = Pick<VoiceState, 'language' | 'pttMode' | 'sendWhenDone' | 'live'>;

const DEFAULTS: VoicePrefs = { language: 'auto', pttMode: 'hold', sendWhenDone: false, live: true };
const KEYS = {
  language: 'voice.language',
  pttMode: 'voice.pttMode',
  sendWhenDone: 'voice.sendWhenDone',
  live: 'voice.live',
};

const isLanguage = (v: unknown): v is TranscribeLanguage =>
  v === 'auto' || (SPEECH_LANGUAGES as readonly unknown[]).includes(v);

function sanitize(saved: Record<string, unknown>): Partial<VoiceState> {
  const out: Partial<VoiceState> = {};
  if (isLanguage(saved['language'])) out.language = saved['language'];
  if (saved['pttMode'] === 'hold' || saved['pttMode'] === 'toggle') out.pttMode = saved['pttMode'];
  if (typeof saved['sendWhenDone'] === 'boolean') out.sendWhenDone = saved['sendWhenDone'];
  if (typeof saved['live'] === 'boolean') out.live = saved['live'];
  return out;
}

/**
 * Voice input: the microphone button and the push-to-talk key start and finish a recording through CopilotKit's
 * `CopilotChatAudioRecorder` (the input's transcribe mode mounts it in place of the editor while a recording is wanted), the audio goes to the backend's Whistle, and the transcript is
 * inserted at the caret of the composer (and sent only when "send when done" is on). With "live" on (the default) the speech is also tapped as
 * 16 kHz PCM and sent a second at a time, so the words appear while the user speaks and the rest is ready the moment they stop; if the live route
 * is unavailable the recorder's blob is converted to WAV and uploaded instead. The store also holds the engine status for Settings › Voice.
 */
export const VoiceStore = signalStore(
  { providedIn: 'root' },
  withState<VoiceState>({
    ...DEFAULTS,
    phase: 'idle',
    byKey: false,
    partial: '',
    error: undefined,
    recorderWanted: false,
    status: undefined,
    statusError: undefined,
    requesting: false,
  }),
  withProps(() => ({ _policy: inject(VOICE_POLICY) })),
  // No first-paint copy in localStorage: the store is created while the toolbar renders, and a trait that patches state in `onInit` would write
  // a signal during a render (NG0600). The choices come from the backend a moment later; nothing in the first paint depends on them.
  withPersistence<VoiceState>({
    remote: {
      keys: KEYS,
      parse: (saved) =>
        sanitize({
          language: saved[KEYS.language],
          pttMode: saved[KEYS.pttMode],
          sendWhenDone: saved[KEYS.sendWhenDone],
          live: saved[KEYS.live],
        }),
    },
  }),
  withComputed((store) => {
    const translate = inject(Language).t;
    const prefs = inject(ViewPrefs);
    const combo = computed(() => prefs.combos()['push-to-talk'] ?? 'alt+space');
    const isMac = inject(IS_MAC);
    const keyLabel = computed(() => formatCombo(combo(), isMac));
    return {
      combo,
      /** The push-to-talk key as drawn (`⌥Space`). */
      keyLabel,
      /** A recording is wanted, running or being transcribed: the mic button shows it, the key does not start another. */
      active: computed(
        () => store.phase() === 'starting' || store.phase() === 'listening' || store.phase() === 'transcribing',
      ),
      listening: computed(() => store.phase() === 'listening'),
      modelReady: computed(() => store.status()?.model.state === 'ready'),
      /** The hint row's sentence. */
      hint: computed(() => {
        const model = store.status()?.model;
        const percent =
          model?.state === 'downloading' && model.bytes
            ? Math.min(100, Math.round(((model.receivedBytes ?? 0) / model.bytes) * 100))
            : undefined;
        return voiceHint(translate, store.phase(), {
          key: keyLabel(),
          mode: store.pttMode(),
          byKey: store.byKey(),
          partial: store.partial(),
          error: store.error() ?? (model?.state === 'error' ? model.error : undefined),
          ...(percent !== undefined ? { downloadPercent: percent } : {}),
          ...(model ? { modelMb: Math.max(1, Math.round(model.bytes / 1_000_000)) } : {}),
        });
      }),
      /** 0 to 100 while the model downloads. */
      downloadPercent: computed(() => {
        const model = store.status()?.model;
        return model?.state === 'downloading' && model.bytes
          ? Math.min(100, Math.round(((model.receivedBytes ?? 0) / model.bytes) * 100))
          : undefined;
      }),
      forcedLanguage: computed<SpeechLanguage | undefined>(() =>
        store.language() === 'auto' ? undefined : (store.language() as SpeechLanguage),
      ),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const chat = inject(ChatStore);
    const ui = inject(UiStore);
    const dialogs = inject(DialogStore);
    const toasts = inject(ToastStore);
    const capture = inject(VoiceCapture);

    /** Everything that is not state: the recorder, the live session, the timers. */
    const run = {
      recorder: undefined as CopilotChatAudioRecorder | undefined,
      /** What the recorder's `error` output said since it was mounted (CopilotKit's own start() may fail before the store looks). */
      recorderError: undefined as Error | undefined,
      recorderErrors: undefined as { unsubscribe(): void } | undefined,
      waiters: [] as ((r: CopilotChatAudioRecorder) => void)[],
      startedAt: 0,
      stopRequested: false,
      cancelRequested: false,
      pttDown: undefined as { code: string; key: string } | undefined,
      liveId: undefined as string | undefined,
      liveFailed: undefined as string | undefined,
      tap: undefined as Pick<PcmTap, 'stop'> | undefined,
      sends: Promise.resolve(),
      transcript: emptyTranscript() as TranscriptSoFar,
      watch: undefined as AbortController | undefined,
      errorTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      poll: undefined as ReturnType<typeof setTimeout> | undefined,
    };

    // ---- engine status, download

    /** Takes the backend's status in; polls while the model downloads, and ends the first-use prompt when it is there. */
    function takeStatus(status: TranscribeStatus): void {
      patchState(store, { status, statusError: undefined });
      clearTimeout(run.poll);
      if (status.model.state === 'downloading')
        run.poll = setTimeout(() => void loadStatus(), store._policy.statusPollMs);
      else if (store.phase() === 'setup' && status.model.state === 'ready') {
        patchState(store, { phase: 'idle', error: undefined });
        toasts.show(
          'info',
          translate('chat.voiceStore.whistleIsReadyAndSpeak', {
            value1:
              store.pttMode() === 'hold'
                ? translate('chat.voiceStore.hold', { value1: store.keyLabel() })
                : translate('chat.voiceStore.press', { value1: store.keyLabel() }),
          }),
        );
      }
    }

    async function loadStatus(): Promise<void> {
      try {
        takeStatus(await unwrap(transcribeStatus({ client: api.client })));
      } catch (error) {
        patchState(store, { statusError: errorMessage(error) });
      }
    }

    async function download(): Promise<void> {
      patchState(store, { requesting: true });
      try {
        takeStatus(await unwrap(transcribeDownload({ client: api.client, body: { accept: true } })));
      } catch (error) {
        patchState(store, { statusError: errorMessage(error) });
      } finally {
        patchState(store, { requesting: false });
      }
    }

    async function removeModel(): Promise<void> {
      try {
        patchState(store, { status: await unwrap(transcribeRemove({ client: api.client })), statusError: undefined });
      } catch (error) {
        patchState(store, { statusError: errorMessage(error) });
      }
    }

    // ---- a recording

    function fail(error: unknown): void {
      clearTimeout(run.errorTimer);
      patchState(store, { phase: 'error', error: friendly(error), recorderWanted: false, partial: '' });
      run.errorTimer = setTimeout(() => {
        if (store.phase() === 'error') patchState(store, { phase: 'idle', error: undefined });
      }, store._policy.errorMs);
    }

    function finish(): void {
      patchState(store, { phase: 'idle', recorderWanted: false, partial: '', byKey: false });
    }

    function friendly(error: unknown): string {
      const text = errorMessage(error);
      if (/permission denied|NotAllowed/i.test(text))
        return translate('chat.voiceStore.microphoneAccessWasDeniedAllowItFor');
      if (/No microphone|NotFound/i.test(text)) return translate('chat.voiceStore.noMicrophoneWasFound');
      return text;
    }

    /** The input container tells us here which recorder CopilotKit mounted (one while `recorderWanted` is set, none otherwise). */
    function attachRecorder(recorder: CopilotChatAudioRecorder | undefined): void {
      run.recorderErrors?.unsubscribe();
      run.recorder = recorder;
      run.recorderError = undefined;
      // Listen from the first moment: the reason (permission denied, no microphone) comes out of the recorder's `error` output, and
      // CopilotKit's input starts the recorder as soon as it is mounted, so the failure can be out before the store asks.
      run.recorderErrors = recorder?.error.subscribe((error) => {
        run.recorderError = error;
      });
      if (recorder) for (const wake of run.waiters.splice(0)) wake(recorder);
    }

    /** Resolves once the recorder has its stream; rejects when it gave up (permission denied, no microphone) or nothing happened in time. */
    function recording(recorder: CopilotChatAudioRecorder): Promise<void> {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const look = (): void => {
          if (run.recorderError) return reject(run.recorderError);
          if (recorder.getState() === 'recording') return resolve();
          if (Date.now() - started > store._policy.readyWaitMs)
            return reject(new Error(translate('chat.voiceStore.theMicrophoneDidNotStart')));
          setTimeout(look, 25);
        };
        look();
      });
    }

    function recorderReady(): Promise<CopilotChatAudioRecorder> {
      if (run.recorder) return Promise.resolve(run.recorder);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(translate('chat.voiceStore.theRecorderDidNotStart'))),
          store._policy.readyWaitMs,
        );
        run.waiters.push((recorder) => {
          clearTimeout(timer);
          resolve(recorder);
        });
      });
    }

    async function openLive(): Promise<void> {
      run.liveId = undefined;
      run.liveFailed = undefined;
      run.transcript = emptyTranscript();
      try {
        const id = await unwrap(
          transcribeStartLive({ client: api.client, query: { language: store.forcedLanguage() }, signal: undefined }),
        ).then(({ id }) => id);
        const watch = new AbortController();
        run.liveId = id;
        run.watch = watch;
        run.sends = Promise.resolve();
        void (async () => {
          const { stream } = await transcribeEvents({
            client: api.client,
            path: { id },
            signal: watch.signal,
            sseMaxRetryAttempts: 1,
          });
          for await (const data of stream) {
            const parsed = TranscribeStreamEventSchema.safeParse(data);
            if (!parsed.success) continue;
            const event = parsed.data;

            if (event.type === 'partial') {
              run.transcript = mergePartial(run.transcript, event);
              if (store.recorderWanted()) patchState(store, { partial: transcriptText(run.transcript) });
            } else if (event.type === 'error') run.liveFailed = event.message;
          }
        })().catch(() => undefined);
        run.tap = await capture.openTap((chunk) => {
          // One request at a time, in order: the engine reads the chunks as a stream.
          run.sends = run.sends
            .then(() =>
              unwrap(
                transcribeChunk({
                  client: api.client,
                  path: { id },
                  body: new Blob([new Uint8Array(floatToPcm16Bytes(chunk))], { type: 'application/octet-stream' }),
                }),
              ),
            )
            .catch((error) => void (run.liveFailed ??= errorMessage(error)));
        });
      } catch (error) {
        // Live is a nicety: the recorder's own recording is uploaded when the user is done.
        run.liveFailed = errorMessage(error);
        await dropLive();
      }
    }

    async function dropLive(): Promise<void> {
      const id = run.liveId;
      run.liveId = undefined;
      run.watch?.abort();
      run.watch = undefined;
      const tap = run.tap;
      run.tap = undefined;
      await tap?.stop().catch(() => undefined);
      if (id) await unwrap(transcribeAbort({ client: api.client, path: { id } })).catch(() => undefined);
    }

    async function start(byKey: boolean): Promise<void> {
      if (store.active() || !chat.threadId()) return;
      clearTimeout(run.errorTimer);
      run.stopRequested = false;
      run.cancelRequested = false;
      // "Starting" from the first instant: a key let go while the status is still being asked for must still end the recording.
      patchState(store, { error: undefined, partial: '', byKey, phase: 'starting' });
      if (!store.status()) await loadStatus();
      if (store.status()?.model.state !== 'ready') {
        // The first use: ask before anything is downloaded. The hint row has the button.
        patchState(store, { phase: 'setup', recorderWanted: false });
        if (store.status()?.model.state === 'downloading')
          run.poll = setTimeout(() => void loadStatus(), store._policy.statusPollMs);
        return;
      }
      patchState(store, { recorderWanted: true });
      try {
        const access = await window.piKit?.requestMicrophone?.();
        if (access && !access.granted)
          throw new Error(access.message ?? translate('chat.voiceStore.microphoneAccessIsOffForPiKit'));
        const recorder = await recorderReady();
        // CopilotKit's input starts the recorder itself when its mode flips to transcribe; this start() then returns at once while that
        // one is still asking for the microphone, so wait until the recorder says it is recording (stop() rejects before that).
        await recorder.start();
        await recording(recorder);
        run.startedAt = Date.now();
        if (store.live()) await openLive();
        if (run.cancelRequested) return void (await cancel());
        patchState(store, { phase: 'listening' });
        // The key was let go (or the button pressed again) while the microphone was starting.
        if (run.stopRequested) await stop();
      } catch (error) {
        await dropLive();
        if (run.recorder) await run.recorder.stop().catch(() => undefined);
        fail(error);
      }
    }

    /** The "Download Whistle (17 MB)" button of the first-use prompt, and of Settings › Voice: the one place a download starts. */
    async function acceptDownload(): Promise<void> {
      await download();
      if (store.phase() === 'setup' && store.status()?.model.state === 'error')
        patchState(store, { error: store.status()?.model.error });
    }

    function dismissSetup(): void {
      if (store.phase() === 'setup') patchState(store, { phase: 'idle', error: undefined });
    }

    /** Finishes the recording: the transcript goes into the composer. */
    async function stop(): Promise<void> {
      if (store.phase() === 'starting') {
        run.stopRequested = true;
        return;
      }
      if (store.phase() !== 'listening') return;
      const spoke = Date.now() - run.startedAt;
      patchState(store, { phase: 'transcribing' });
      try {
        const recorder = run.recorder;
        if (!recorder) throw new Error(translate('chat.voiceStore.theRecorderIsGone'));
        const blob = await recorder.stop();
        if (spoke < MIN_SPEECH_MS) {
          await dropLive();
          finish();
          toasts.show(
            'info',
            store.pttMode() === 'hold'
              ? translate('chat.voiceStore.holdWhileYouSpeak', { value1: store.keyLabel() })
              : translate('chat.voiceStore.thatWasTooShortToHear'),
          );
          return;
        }
        let text: string;
        const id = run.liveId;
        if (id && !run.liveFailed) {
          await run.tap?.stop();
          run.tap = undefined;
          await run.sends;
          text = run.liveFailed
            ? await uploaded(blob)
            : (await unwrap(transcribeEnd({ client: api.client, path: { id } }))).text;
          run.liveId = undefined;
          run.watch?.abort();
        } else {
          await dropLive();
          text = await uploaded(blob);
        }
        if (run.cancelRequested) return finish();
        finish();
        await deliver(text);
      } catch (error) {
        await dropLive();
        fail(error);
      }
    }

    /** The fallback: the recorder's blob, decoded by the browser, as a WAV. */
    async function uploaded(blob: Blob): Promise<string> {
      await dropLive();
      const { samples, sampleRate } = await capture.decode(blob);
      return (
        await unwrap(
          transcribeRecording({
            client: api.client,
            body: new Blob([new Uint8Array(encodeWav16(samples, sampleRate))], { type: 'audio/wav' }),
            query: { language: store.forcedLanguage() },
            signal: undefined,
          }),
        )
      ).text;
    }

    async function deliver(text: string): Promise<void> {
      if (!text.trim()) return toasts.show('info', translate('chat.voiceStore.nothingWasHeardTryAgainALittle'));
      chat.insertText(text);
      chat.focusComposer();
      if (store.sendWhenDone()) await chat.submit();
    }

    /** Esc while listening: the recording is thrown away. */
    async function cancel(): Promise<void> {
      if (store.phase() === 'starting') {
        run.cancelRequested = true;
        return;
      }
      if (store.phase() !== 'listening') return;
      run.cancelRequested = true;
      await dropLive();
      await run.recorder?.stop().catch(() => undefined);
      finish();
    }

    /** The microphone button: start, or finish. */
    async function toggle(): Promise<void> {
      if (store.phase() === 'transcribing') return;
      if (store.phase() === 'starting' || store.phase() === 'listening') return stop();
      return start(false);
    }

    // ---- the push-to-talk key

    /** Voice is for the composer: not behind a dialog, the settings or the command palette, and not in the terminal. */
    const allowed = (event: KeyboardEvent): boolean =>
      !!chat.threadId() &&
      !ui.settings() &&
      !ui.palette() &&
      !dialogs.current() &&
      !(event.target as HTMLElement | null)?.closest?.('.xterm');

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && store.phase() === 'listening') return void cancel();
      if (!eventMatches(store.combo(), event) || !allowed(event)) return;
      // ⌥Space would type a no-break space into the textarea.
      event.preventDefault();
      const action = pushToTalk(
        store.pttMode(),
        { recording: store.phase() === 'starting' || store.phase() === 'listening' },
        'down',
        event.repeat,
      );
      if (action === 'start') {
        run.pttDown = { code: event.code, key: event.key };
        void start(true);
      } else if (action === 'stop') void stop();
    }

    function onKeyUp(event: KeyboardEvent): void {
      if (!run.pttDown || store.pttMode() !== 'hold' || !releasesCombo(store.combo(), run.pttDown, event)) return;
      run.pttDown = undefined;
      if (
        pushToTalk('hold', { recording: store.phase() === 'starting' || store.phase() === 'listening' }, 'up') ===
        'stop'
      )
        void stop();
    }

    function onBlur(): void {
      if (!run.pttDown) return;
      run.pttDown = undefined;
      if (
        pushToTalk('hold', { recording: store.phase() === 'starting' || store.phase() === 'listening' }, 'blur') ===
        'stop'
      )
        void stop();
    }

    const bindKeys = rxMethod<Event>(
      tap((event) => {
        if (event.type === 'keydown') onKeyDown(event as KeyboardEvent);
        else if (event.type === 'keyup') onKeyUp(event as KeyboardEvent);
        else onBlur();
      }),
    );

    return {
      loadStatus,
      download,
      acceptDownload,
      dismissSetup,
      removeModel,
      attachRecorder,
      start,
      stop,
      cancel,
      toggle,
      /** Changes a choice of Settings › Voice; resolves to whether the backend saved it. */
      set<K extends keyof VoicePrefs>(key: K, value: VoicePrefs[K]): Promise<boolean> {
        return store.persist({ [key]: value } as Partial<VoiceState>);
      },
      _bindKeys: () =>
        bindKeys(merge(fromEvent(document, 'keydown'), fromEvent(document, 'keyup'), fromEvent(window, 'blur'))),
    };
  }),
  withHooks({
    onInit(store) {
      void store.loadPersisted();
      store._bindKeys();
    },
  }),
);
export type VoiceStore = InstanceType<typeof VoiceStore>;
