# ADR-0017: Local voice input with Whistle and the compact composer toolbar

Status: Accepted
Date: 2026-10-16

## Context

Dictation into the composer must run on the user's machine: no audio leaves it, and nothing is fetched without consent.
Whistle is a 16.9 MB CPU-only speech-to-text model (seven languages, Apache-2.0) taking 16 kHz mono floats, up to 30 s per call or any length as a stream of one-second chunks.
Its engine, Cactus's `needle`, exists as the npm package `cactus-needle` (WebAssembly in a worker thread) and as a Python package.
CopilotKit ships `CopilotChatAudioRecorder` (a `MediaRecorder` plus waveform) whose own transcription needs a runtime pi-kit does not have, so only the recorder is usable.
The composer toolbar must hold the microphone alongside the model and effort chips in one compact row that yields gracefully at narrow widths.

## Decision

- **Engine.** `TranscribeService` (`apps/backend/src/transcribe/`) loads `cactus-needle` by native `import()` with `weights: <path>, download: false` and `fetch` off in its worker, so the only download is pi-kit's own. If the WASM engine cannot start it falls back to the Python package (`NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK=1`), without live partials. `GET /api/transcribe/status` names the engine. `PI_KIT_TRANSCRIBE_ENGINE=fake` selects a test engine, ignored in production. One model, one request at a time, released after ten idle minutes.
- **Model consent and pin.** Never bundled, never fetched on its own: `POST /api/transcribe/model` needs `{ "accept": true }` (400 otherwise); the composer's first use and Settings › Voice both offer a "Download Whistle (17 MB)" button, and Settings has Remove. The file is pinned to a Hugging Face revision, byte size and SHA-256, streamed to `whistle.cact.part`, hashed on the way and renamed into `<data dir>/models/whistle/whistle.cact` (mode 0600) only on a match; the hash is rechecked at every engine load. `PI_KIT_WHISTLE_URL`, `_SHA256` and `_BYTES` override for tests and are ignored in production.
- **Audio.** `POST /api/transcribe?language=` takes a recording body and answers `{ text, language, durationMs, tookMs, words? }`. WAV in any format is parsed in TypeScript, channels averaged and resampled to 16 kHz with a windowed sinc; other containers go through `ffmpeg` when installed, else 415. The renderer decodes the recorder's blob with `decodeAudioData` and uploads 16-bit WAV, so no decoder ships. Silence and clicks answer empty without the engine; over 28 s runs as a stream.
- `POST /api/transcribe/stream` answers as server-sent events (`partial`, `done`, `error`) folded by `mergePartial` and `transcriptText` in `@pi-kit/protocol`. **Live** is several requests (`POST /api/transcribe/live`, `…/:id/chunk`, `GET …/:id/events`, `POST …/:id/end`, `DELETE …/:id`): the renderer taps the microphone at 16 kHz with an `AudioWorklet`, sends one-second PCM chunks and reads events; the recorder's blob is the fallback. One live session at a time, ended after 30 s without audio.
- **`VoiceStore`** keeps the choices (language, hold or toggle, live words, send when done) in pi-kit's database under `voice.*`, the engine status, the phase and the recording; no `localStorage` copy. Text goes in at the caret through `ChatStore.insertText`; `submit()` runs only with "send when done". A recording under 400 ms is a tap and is not transcribed; Esc while listening discards.
- **Push-to-talk** is the shortcut `push-to-talk` (default ⌥Space, editable with conflict detection). The matcher reads `code === 'Space'` because ⌥Space types a no-break space. Hold mode ends on release of Space or ⌥, or on window blur; the pure `pushToTalk` function decides.
- **The recorder** is mounted only while a recording is wanted, by putting `copilot-chat-input` into CopilotKit's `transcribe` mode so the waveform replaces the editor row; the draft waits in `ChatStore`. The store waits for the recorder to report `recording` before treating the microphone as open. (A hint-row strip was the earlier variant.)
- **Settings › Voice** shows engine and model status, Download / Remove, language, key, hold / toggle, live words, send when done, and the privacy note: audio goes to the backend on 127.0.0.1, nothing is recorded to disk or sent over the network.
- **Electron** asks `systemPreferences.askForMediaAccess('microphone')` through `pi-kit:microphone-access` (`apps/desktop/src/microphone.ts`) and, after a refusal, opens System Settings; the app carries `NSMicrophoneUsageDescription` and the `com.apple.security.device.audio-input` entitlement.
- **Compact toolbar**: one row of 32 px controls (`.pk-toolbar.compact`). Left: the tools pill (⊕, `@`, `!`), extension buttons as round ghosts, the model and effort chips, and `pk-deliver-chip` (Steer / Follow-up) while pi runs. Right: the microphone, the context ring and one round button, amber ↑ to send or red ■ to stop (Stop and Send are never side by side).
- **The context ring** replaces the meter bar: a 32 px disc, muted, warning from 70 %, error from 90 %, keeping `data-testid="context-meter"`, `data-level` and its text. A click opens the "Context window" popover (`UsageStore`): fill, tokens, where pi compacts, cost and cache hit from `GET /api/threads/:id/usage`, "Usage by turn" and "Compact now" (`/compact`, disabled while running).
- **Yielding**: the "Deliver" word drops under 680 px of container width, then chips truncate; under 768 px the toolbar is two rows with chips on the second. The right cluster never moves.

## Consequences

- Dependencies gain `cactus-needle` (exact) and its transitive packages, none in the renderer bundle.
- `ComposerToolbar` no longer draws Stop and Send together, a Steer / Follow-up radio group or `.pk-meter`; tests reach the usage dialog through the ring and "Usage by turn".
- `VoiceStore` is created during render, so it cannot patch state in `onInit`; `UsageStore` has one `open`, derived from the thread it was opened for.
- The Python fallback has no live partials and is a last resort; the WASM engine is what ships.
- Read-aloud (the assistant message's speaker button) is out of scope.
