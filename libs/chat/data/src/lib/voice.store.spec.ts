import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  appSettingsSetSetting,
  appSettingsSettings,
  provideMockApi,
  transcribeAbort,
  transcribeChunk,
  transcribeDownload,
  transcribeEnd,
  transcribeRecording,
  transcribeRemove,
  transcribeStartLive,
  transcribeStatus,
} from '@pi-kit/api';
import { DialogStore, ToastStore, UiStore, ViewPrefs } from '@pi-kit/data-access';
import type { TranscribeStatus } from '@pi-kit/protocol';
import { ChatStore } from './chat.store';

import { VoiceCapture } from './voice-capture';
import { VoiceStore } from './voice.store';

const tapStop = vi.fn(async () => undefined);
let tapOnChunk: ((pcm: Float32Array) => void) | undefined;
const capture = {
  openTap: vi.fn(async (onChunk: (pcm: Float32Array) => void) => {
    tapOnChunk = onChunk;
    return { stop: tapStop };
  }),
  decode: vi.fn(async () => ({ samples: new Float32Array(16000), sampleRate: 16000 })),
};

const status = (
  state: 'missing' | 'downloading' | 'ready' | 'error',
  extra: Partial<TranscribeStatus['model']> = {},
): TranscribeStatus => ({
  engine: 'wasm',
  note: 'note',
  model: {
    name: 'Whistle',
    file: 'whistle.cact',
    bytes: 16_919_407,
    sha256: 'ab'.repeat(32),
    source: 'huggingface.co/Cactus-Compute/whistle',
    license: 'Apache-2.0',
    state,
    path: '/data/whistle.cact',
    ...extra,
  },
  decoders: { ffmpeg: false },
  python: { available: null },
  languages: ['en', 'de'],
  loaded: false,
});

describe('VoiceStore', () => {
  const chat = {
    threadId: signal<string | undefined>('t1'),
    insertText: vi.fn(),
    submit: vi.fn(async () => undefined),
    focusComposer: vi.fn(),
  };
  const toasts = { show: vi.fn() };
  const ui = { settings: () => null, palette: () => false, openSettings: vi.fn() };
  const api = {
    status: vi.fn(async () => status('ready')),
    download: vi.fn(async () => status('ready')),
    removeModel: vi.fn(async () => status('missing')),
    transcribe: vi.fn(async () => ({
      text: 'please add a test',
      language: 'en' as const,
      durationMs: 2000,
      tookMs: 100,
    })),
    startLive: vi.fn(async () => 'live-1'),
    pushLive: vi.fn(async () => undefined),
    endLive: vi.fn(async () => ({ text: 'live words', language: 'en' as const, durationMs: 2000, tookMs: 100 })),
    abortLive: vi.fn(async () => undefined),
    watchLive: vi.fn(
      async (_id: string, _onEvent: (e: unknown) => void, _signal?: AbortSignal): Promise<void> => undefined,
    ),
  };
  // The shape of CopilotKit's recorder the store relies on: start() flips the state to "recording" (its own input starts it too in transcribe
  // mode, so the store waits for the state), stop() answers with the blob, and a failed start comes out of the `error` output.
  const recorderState = { value: 'idle' as 'idle' | 'recording' | 'processing' };
  const errorListeners = new Set<(error: Error) => void>();
  const recorder = {
    start: vi.fn(async () => {
      recorderState.value = 'recording';
    }),
    stop: vi.fn(async () => {
      recorderState.value = 'idle';
      return new Blob(['x'], { type: 'audio/webm' });
    }),
    getState: () => recorderState.value,
    error: {
      subscribe: (listener: (error: Error) => void) => {
        errorListeners.add(listener);
        return { unsubscribe: () => errorListeners.delete(listener) };
      },
    },
  };
  const prefs = { combos: () => ({ 'push-to-talk': 'alt+space' }) };

  const make = async () => {
    const voice = TestBed.inject(VoiceStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    return voice;
  };
  /** The hint row mounts the recorder once a recording is wanted; the test plays that part. */
  const mountRecorder = (voice: InstanceType<typeof VoiceStore>) => voice.attachRecorder(recorder as never);
  const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent(type, {
      key: ' ',
      code: 'Space',
      altKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    document.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    for (const fn of [
      ...Object.values(api),
      recorder.start,
      recorder.stop,
      chat.insertText,
      chat.submit,
      chat.focusComposer,
      toasts.show,
      tapStop,
    ])
      (fn as ReturnType<typeof vi.fn>).mockClear();
    api.status.mockImplementation(async () => status('ready'));
    recorderState.value = 'idle';
    errorListeners.clear();
    chat.threadId.set('t1');
    tapOnChunk = undefined;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStore, useValue: chat },
        { provide: ToastStore, useValue: toasts },
        { provide: UiStore, useValue: ui },
        { provide: DialogStore, useValue: { current: () => undefined } },
        { provide: ViewPrefs, useValue: prefs },
        { provide: VoiceCapture, useValue: capture },
        ...provideMockApi(
          [
            [transcribeStatus, api.status, () => []],
            [transcribeDownload, api.download, () => []],
            [transcribeRemove, api.removeModel, () => []],
            [
              transcribeRecording,
              api.transcribe,
              async (o) => [
                new Uint8Array(await (o.body as unknown as Blob).arrayBuffer()),
                o.query?.['language'],
                o.signal,
              ],
            ],
            [transcribeStartLive, api.startLive, (o) => [o.query?.['language'], o.signal], (id) => ({ id })],
            [
              transcribeChunk,
              api.pushLive,
              async (o) => [o.path?.['id'], new Uint8Array(await (o.body as unknown as Blob).arrayBuffer())],
            ],
            [transcribeEnd, api.endLive, (o) => [o.path?.['id']]],
            [transcribeAbort, api.abortLive, (o) => [o.path?.['id']]],
            [appSettingsSettings, { all: async () => ({}), set: async () => undefined }.all, () => []],
            [
              appSettingsSetSetting,
              { all: async () => ({}), set: async () => undefined }.set,
              (o) => [o.path?.['key'], o.body?.['value']],
            ],
          ],
          [
            [
              /^\/api\/transcribe\/live\/[^/]+\/events$/,
              api.watchLive,
              (path, onLine, signal) => [decodeURIComponent(path.split('/')[4]), onLine, signal],
            ],
          ],
        ),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('the first use asks before anything is downloaded, and the button is the only thing that downloads', async () => {
    api.status.mockImplementation(async () => status('missing'));
    const voice = await make();
    await voice.start(false);
    expect(voice.phase()).toBe('setup');
    expect(voice.hint()).toMatch(/needs a one-time 17 MB download/);
    expect(api.download).not.toHaveBeenCalled();
    expect(recorder.start).not.toHaveBeenCalled();
    expect(voice.recorderWanted()).toBe(false);
    api.status.mockImplementation(async () => status('ready'));
    await voice.acceptDownload();
    expect(api.download).toHaveBeenCalledTimes(1);
    expect(voice.phase()).toBe('idle');
    expect(toasts.show).toHaveBeenCalledWith('info', expect.stringMatching(/Whistle is ready. Hold (⌥|Alt\+)Space/));
  });

  it('shows the progress of a download, and "not now" puts the prompt away', async () => {
    api.status.mockImplementation(async () => status('missing'));
    const voice = await make();
    await voice.start(false);
    api.download.mockImplementationOnce(async () => status('downloading', { receivedBytes: 8_459_703 }));
    await voice.acceptDownload();
    expect(voice.downloadPercent()).toBe(50);
    expect(voice.hint()).toBe('Downloading Whistle… 50%');
    api.status.mockImplementationOnce(async () => status('downloading', { receivedBytes: 12_689_555 }));
    await vi.advanceTimersByTimeAsync(600);
    expect(voice.downloadPercent()).toBe(75);
    api.status.mockImplementation(async () => status('ready'));
    await vi.advanceTimersByTimeAsync(600);
    expect(voice.phase()).toBe('idle');
    const second = await make();
    expect(second).toBe(voice);
    voice.dismissSetup();
  });

  it('listens, and puts the transcript at the caret without sending it', async () => {
    const voice = await make();
    await voice.set('live', false);
    const started = voice.start(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(voice.recorderWanted()).toBe(true);
    mountRecorder(voice);
    await started;
    expect(voice.phase()).toBe('listening');
    expect(voice.hint()).toBe('Listening. Click the microphone to finish.');
    await vi.advanceTimersByTimeAsync(1500);
    await voice.stop();
    expect(api.transcribe).toHaveBeenCalledTimes(1);
    expect(chat.insertText).toHaveBeenCalledWith('please add a test');
    expect(chat.submit).not.toHaveBeenCalled();
    expect(voice.phase()).toBe('idle');
    expect(voice.recorderWanted()).toBe(false);
  });

  it('"send when done" sends it', async () => {
    const voice = await make();
    await voice.set('live', false);
    await voice.set('sendWhenDone', true);
    const started = voice.start(false);
    await vi.advanceTimersByTimeAsync(0);
    mountRecorder(voice);
    await started;
    await vi.advanceTimersByTimeAsync(1500);
    await voice.stop();
    expect(chat.insertText).toHaveBeenCalledWith('please add a test');
    expect(chat.submit).toHaveBeenCalledTimes(1);
  });

  it('live: the audio goes up in order while it is spoken, the words appear in the hint, the result comes from the session', async () => {
    api.watchLive.mockImplementationOnce(async (_id: string, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'partial', text: 'please add', pending: 'a unit', receivedSeconds: 1 });
      onEvent({ type: 'partial', text: 'a unit test', pending: '', receivedSeconds: 2 });
    });
    const voice = await make();
    const started = voice.start(true);
    await vi.advanceTimersByTimeAsync(0);
    mountRecorder(voice);
    await started;
    await vi.advanceTimersByTimeAsync(0);
    expect(api.startLive).toHaveBeenCalledWith(undefined, undefined);
    expect(voice.partial()).toBe('please add a unit test');
    expect(voice.hint()).toBe('please add a unit test');
    tapOnChunk?.(new Float32Array(16000));
    tapOnChunk?.(new Float32Array(8000));
    await vi.advanceTimersByTimeAsync(1500);
    await voice.stop();
    expect(api.pushLive).toHaveBeenCalledTimes(2);
    expect(api.endLive).toHaveBeenCalledWith('live-1');
    expect(api.transcribe).not.toHaveBeenCalled();
    expect(chat.insertText).toHaveBeenCalledWith('live words');
  });

  it('live that cannot start falls back to the recorder’s own recording', async () => {
    api.startLive.mockRejectedValueOnce(new Error('busy'));
    const voice = await make();
    const started = voice.start(false);
    await vi.advanceTimersByTimeAsync(0);
    mountRecorder(voice);
    await started;
    expect(voice.phase()).toBe('listening');
    await vi.advanceTimersByTimeAsync(1500);
    await voice.stop();
    expect(api.transcribe).toHaveBeenCalledTimes(1);
    expect(chat.insertText).toHaveBeenCalledWith('please add a test');
  });

  it('a tap on the key is not speech: nothing is transcribed and the toast says how to use it', async () => {
    const voice = await make();
    await voice.set('live', false);
    const started = voice.start(true);
    await vi.advanceTimersByTimeAsync(0);
    mountRecorder(voice);
    await started;
    await vi.advanceTimersByTimeAsync(100);
    await voice.stop();
    expect(api.transcribe).not.toHaveBeenCalled();
    expect(chat.insertText).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith('info', expect.stringMatching(/^Hold (⌥|Alt\+)Space while you speak.$/));
    expect(voice.phase()).toBe('idle');
  });

  it('says nothing was heard instead of inserting an empty message', async () => {
    api.transcribe.mockResolvedValueOnce({ text: '  ', language: '' as never, durationMs: 1000, tookMs: 10 });
    const voice = await make();
    await voice.set('live', false);
    const started = voice.start(false);
    await vi.advanceTimersByTimeAsync(0);
    mountRecorder(voice);
    await started;
    await vi.advanceTimersByTimeAsync(1500);
    await voice.stop();
    expect(chat.insertText).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith('info', expect.stringContaining('Nothing was heard'));
  });

  it('a refused microphone is an error that says what to do, and it clears by itself', async () => {
    const voice = await make();
    // As CopilotKit does it: start() settles without recording and the reason comes out of the `error` output.
    recorder.start.mockImplementationOnce(async () => {
      for (const listener of errorListeners) listener(new Error('Microphone permission denied'));
    });
    const started = voice.start(false);
    await vi.advanceTimersByTimeAsync(0);
    mountRecorder(voice);
    await started;
    expect(voice.phase()).toBe('error');
    expect(voice.hint()).toMatch(/Microphone access was denied/);
    expect(voice.recorderWanted()).toBe(false);
    await vi.advanceTimersByTimeAsync(9500);
    expect(voice.phase()).toBe('idle');
  });

  it('on a Mac the system’s answer comes first: a refusal stops before the recorder starts', async () => {
    (window as unknown as { piKit: unknown }).piKit = {
      requestMicrophone: vi.fn(async () => ({
        granted: false,
        status: 'denied',
        message: 'Turn it on in System Settings.',
      })),
    };
    try {
      const voice = await make();
      await voice.start(false);
      expect(recorder.start).not.toHaveBeenCalled();
      expect(voice.phase()).toBe('error');
      expect(voice.hint()).toBe('Turn it on in System Settings.');
    } finally {
      delete (window as unknown as { piKit?: unknown }).piKit;
    }
  });

  it('Esc while listening throws the recording away', async () => {
    const voice = await make();
    await voice.set('live', false);
    const started = voice.start(true);
    await vi.advanceTimersByTimeAsync(0);
    mountRecorder(voice);
    await started;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(voice.phase()).toBe('idle');
    expect(api.transcribe).not.toHaveBeenCalled();
    expect(chat.insertText).not.toHaveBeenCalled();
  });

  describe('the push-to-talk key (⌥Space)', () => {
    it('hold: down starts and the release finishes, and the no-break space is never typed', async () => {
      const voice = await make();
      await voice.set('live', false);
      const down = key('keydown');
      expect(down.defaultPrevented).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(voice.phase()).toBe('starting');
      mountRecorder(voice);
      await vi.advanceTimersByTimeAsync(0);
      expect(voice.phase()).toBe('listening');
      // The OS repeats a held key: nothing happens.
      key('keydown', { repeat: true });
      expect(voice.phase()).toBe('listening');
      await vi.advanceTimersByTimeAsync(1500);
      key('keyup', { altKey: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(api.transcribe).toHaveBeenCalledTimes(1);
      expect(chat.insertText).toHaveBeenCalledWith('please add a test');
    });

    it('releasing ⌥ before Space ends it too, and a release before the microphone is up ends it as soon as it is', async () => {
      const voice = await make();
      await voice.set('live', false);
      key('keydown');
      key('keyup', { key: 'Alt', code: 'AltLeft', altKey: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice.phase()).toBe('starting');
      mountRecorder(voice);
      await vi.advanceTimersByTimeAsync(10);
      // It was let go during the start: the recording is a tap and is thrown away.
      expect(voice.phase()).toBe('idle');
      expect(api.transcribe).not.toHaveBeenCalled();
    });

    it('toggle: press to start, press again to finish; the release does nothing', async () => {
      const voice = await make();
      await voice.set('live', false);
      await voice.set('pttMode', 'toggle');
      key('keydown');
      await vi.advanceTimersByTimeAsync(0);
      mountRecorder(voice);
      await vi.advanceTimersByTimeAsync(0);
      key('keyup', { altKey: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice.phase()).toBe('listening');
      await vi.advanceTimersByTimeAsync(1500);
      key('keydown');
      await vi.advanceTimersByTimeAsync(0);
      expect(chat.insertText).toHaveBeenCalledWith('please add a test');
    });

    it('ignores the key without a thread, and any other key', async () => {
      const voice = await make();
      chat.threadId.set(undefined);
      expect(key('keydown').defaultPrevented).toBe(false);
      chat.threadId.set('t1');
      expect(key('keydown', { altKey: false }).defaultPrevented).toBe(false);
      expect(voice.phase()).toBe('idle');
    });
  });

  it('keeps the choices in pi-kit’s database, and rejects a value it does not know when it reads them back', async () => {
    const set = vi.fn(async () => undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStore, useValue: chat },
        { provide: ToastStore, useValue: toasts },
        { provide: UiStore, useValue: ui },
        { provide: DialogStore, useValue: { current: () => undefined } },
        { provide: ViewPrefs, useValue: prefs },
        { provide: VoiceCapture, useValue: capture },
        ...provideMockApi(
          [
            [transcribeStatus, api.status, () => []],
            [transcribeDownload, api.download, () => []],
            [transcribeRemove, api.removeModel, () => []],
            [
              transcribeRecording,
              api.transcribe,
              async (o) => [
                new Uint8Array(await (o.body as unknown as Blob).arrayBuffer()),
                o.query?.['language'],
                o.signal,
              ],
            ],
            [transcribeStartLive, api.startLive, (o) => [o.query?.['language'], o.signal], (id) => ({ id })],
            [
              transcribeChunk,
              api.pushLive,
              async (o) => [o.path?.['id'], new Uint8Array(await (o.body as unknown as Blob).arrayBuffer())],
            ],
            [transcribeEnd, api.endLive, (o) => [o.path?.['id']]],
            [transcribeAbort, api.abortLive, (o) => [o.path?.['id']]],
            [
              appSettingsSettings,
              {
                all: async () => ({ 'voice.language': 'de', 'voice.pttMode': 'sideways', 'voice.sendWhenDone': true }),
                set,
              }.all,
              () => [],
            ],
            [
              appSettingsSetSetting,
              {
                all: async () => ({ 'voice.language': 'de', 'voice.pttMode': 'sideways', 'voice.sendWhenDone': true }),
                set,
              }.set,
              (o) => [o.path?.['key'], o.body?.['value']],
            ],
          ],
          [
            [
              /^\/api\/transcribe\/live\/[^/]+\/events$/,
              api.watchLive,
              (path, onLine, signal) => [decodeURIComponent(path.split('/')[4]), onLine, signal],
            ],
          ],
        ),
      ],
    });
    const voice = await make();
    expect(voice.language()).toBe('de');
    expect(voice.pttMode()).toBe('hold');
    expect(voice.sendWhenDone()).toBe(true);
    expect(voice.live()).toBe(true);
    expect(voice.forcedLanguage()).toBe('de');
    expect(await voice.set('language', 'fr')).toBe(true);
    expect(set).toHaveBeenCalledWith('voice.language', 'fr');
  });
});
