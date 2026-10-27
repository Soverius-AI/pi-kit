import { readFileSync } from 'node:fs';

/**
 * A microphone for tests: `navigator.mediaDevices.getUserMedia({ audio })` answers a stream that plays a WAV file in a loop, made with Web
 * Audio (`createMediaStreamDestination`), so it needs no audio hardware, no permission prompt and no Chromium flags (the fake-device flags need a
 * working audio service, which a sandboxed run does not always have). Everything after it is the real thing: CopilotKit's recorder, `MediaRecorder`,
 * the 16 kHz tap, the backend routes. Call it before the page loads.
 */
export async function fakeMicrophone(page, wavPath) {
  const base64 = readFileSync(wavPath).toString('base64');
  await page.addInitScript((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    window.__fakeMicrophoneOpened = 0;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!constraints?.audio) throw new DOMException('Only audio is available.', 'NotFoundError');
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(bytes.slice().buffer);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const destination = context.createMediaStreamDestination();
      source.connect(destination);
      source.start();
      window.__fakeMicrophoneOpened++;
      const stream = destination.stream;
      // Releasing the microphone stops the loop, as a real one would.
      for (const track of stream.getAudioTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          try {
            source.stop();
            void context.close();
          } catch {
            // already stopped
          }
        };
      }
      return stream;
    };
  }, base64);
}
