import { Injectable } from '@angular/core';
import { Chunker, mixToMono } from '@pi-kit/chat/util';

/**
 * The browser's side of voice input: the pieces CopilotKit's recorder does not do. The recorder gives a WebM/Opus blob
 * when the user is done; `decodeRecording` turns that into samples the backend can read without a decoder, and `PcmTap` listens to the
 * microphone a second time as 16 kHz PCM so the live route can send the speech while it is being said.
 */

/** About a second of speech per request on the live route. */
export const LIVE_CHUNK_SAMPLES = 16_000;

export interface Decoded {
  samples: Float32Array;
  sampleRate: number;
}

/** Decodes a recording with the browser's own decoder (`decodeAudioData`), at 16 kHz where the browser allows it, mono. */
export async function decodeRecording(blob: Blob): Promise<Decoded> {
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: 16_000 });
  } catch {
    context = new AudioContext();
  }
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    return {
      samples: mixToMono(Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i))),
      sampleRate: decoded.sampleRate,
    };
  } finally {
    void context.close();
  }
}

const WORKLET = `
class PkTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('pk-tap', PkTap);
`;

/**
 * The microphone as 16 kHz mono blocks, handed over in pieces of `LIVE_CHUNK_SAMPLES`. It opens its own stream (the recorder keeps its own for the
 * waveform and the fallback recording) and an `AudioContext` pinned to 16 kHz, so the browser does the resampling. `stop()` hands over the tail.
 */
export class PcmTap {
  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly chunker: Chunker,
    private readonly onChunk: (pcm: Float32Array) => void,
    private readonly nodes: AudioNode[],
  ) {}

  static async open(onChunk: (pcm: Float32Array) => void): Promise<PcmTap> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const context = new AudioContext({ sampleRate: 16_000 });
    try {
      await context.resume();
      const chunker = new Chunker(LIVE_CHUNK_SAMPLES);
      const source = context.createMediaStreamSource(stream);
      // Silent output: a graph that reaches no destination is not pulled by every browser.
      const mute = context.createGain();
      mute.gain.value = 0;
      mute.connect(context.destination);
      const feed = (block: Float32Array): void => {
        for (const chunk of chunker.push(block)) onChunk(chunk);
      };
      const nodes: AudioNode[] = [source, mute];
      if (context.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        try {
          await context.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const node = new AudioWorkletNode(context, 'pk-tap');
        node.port.onmessage = (event: MessageEvent<Float32Array>) => feed(event.data);
        source.connect(node);
        node.connect(mute);
        nodes.push(node);
      } else {
        // Older engines: the deprecated script processor does the same job.
        const node = context.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (event) => feed(event.inputBuffer.getChannelData(0).slice(0));
        source.connect(node);
        node.connect(mute);
        nodes.push(node);
      }
      return new PcmTap(stream, context, chunker, onChunk, nodes);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
      throw error;
    }
  }

  /** Stops listening; the last, shorter piece is delivered first. */
  async stop(): Promise<void> {
    const tail = this.chunker.flush();
    if (tail) this.onChunk(tail);
    this.stream.getTracks().forEach((track) => track.stop());
    for (const node of this.nodes) node.disconnect();
    await this.context.close().catch(() => undefined);
  }
}

/** The browser's audio as a service, so the voice store can be tested without a microphone. */
@Injectable({ providedIn: 'root' })
export class VoiceCapture {
  decode(blob: Blob): Promise<Decoded> {
    return decodeRecording(blob);
  }

  /** Starts the 16 kHz tap; `onChunk` gets about a second of speech at a time. */
  openTap(onChunk: (pcm: Float32Array) => void): Promise<Pick<PcmTap, 'stop'>> {
    return PcmTap.open(onChunk);
  }
}
