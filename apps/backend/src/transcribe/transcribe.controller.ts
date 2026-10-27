import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, PayloadTooLargeException, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  DownloadModelSchema,
  type LiveTranscription,
  LiveTranscriptionSchema,
  TRANSCRIBE_MAX_BYTES,
  TranscribeLanguageQuerySchema,
  TranscribeQuerySchema,
  type TranscribeResult,
  TranscribeResultSchema,
  type TranscribeStatus,
  TranscribeStatusSchema,
  type TranscribeStreamEvent,
  TranscribeStreamEventSchema,
} from '@pi-kit/protocol';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { Fails, Responds, Streams } from '../contract';
import { AudioError } from './pcm';
import { parseLanguage, TranscribeService } from './transcribe.service';

/** The request body as bytes: the recording is the body itself (`audio/wav`, `audio/webm`, ...), not JSON or a form. */
async function readBody(req: Request, limit = TRANSCRIBE_MAX_BYTES): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new PayloadTooLargeException(`The recording is larger than ${Math.round(limit / 1024 / 1024)} MB.`);
    chunks.push(chunk);
  }
  const all = Buffer.concat(chunks);
  return new Uint8Array(all.buffer, all.byteOffset, all.byteLength);
}

function sseWriter(res: Response, req: Request): (event: TranscribeStreamEvent) => void {
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  req.on('close', () => res.end());
  return (event) => {
    if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
}

const failure = (error: unknown): never => {
  if (error instanceof AudioError) throw new HttpException(error.message, error.status);
  throw error;
};

const LIVE_ID = { name: 'id', description: 'The id `POST /api/transcribe/live` answered with.', schema: { type: 'string' } } as const;
const NO_LIVE = 'That live transcription is over or never started.';
const AUDIO = ['audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4', 'application/octet-stream'] as const;
const AUDIO_BODY = { description: 'The recording itself as the request body (WAV, or WebM, Ogg or MP4 when ffmpeg is installed), not JSON or a form.', schema: { type: 'string', format: 'binary' } } as const;
const PCM_BODY = { description: '16-bit 16 kHz mono PCM, a few seconds of it, as the request body.', schema: { type: 'string', format: 'binary' } } as const;
const NO_ENGINE = 'Whistle is not downloaded, or no speech engine could start.';
const BAD_AUDIO = 'The recording could not be decoded.';

/**
 * Voice input. Everything is local: the audio is the request body and the text is the response, nothing is stored.
 * `GET status` / `POST model` / `DELETE model` are Settings › Voice; `POST /` is a recording in, text out; `POST stream` the same as server-sent
 * events; `live` takes 16-bit 16 kHz PCM while the user is still speaking and streams the text as it is committed.
 */
@ApiTags('transcribe')
@Controller('transcribe')
export class TranscribeController {
  constructor(private readonly transcribe: TranscribeService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get the voice status', description: 'Returns which engine runs the model, whether the model file is on disk, the decoders and the languages.' })
  @Responds(TranscribeStatusSchema)
  status(): TranscribeStatus {
    return this.transcribe.status();
  }

  /** The user clicked "Download Whistle (17 MB)": `{ "accept": true }`. Without it nothing is fetched. Progress is in `status`. */
  @Post('model')
  @ApiOperation({ summary: 'Download the voice model', description: 'Starts the download of the speech model after the person agreed, with `accept: true`. Progress is in the status.' })
  @Responds(TranscribeStatusSchema, { status: 201 })
  download(@Body({ schema: DownloadModelSchema }) _body: z.infer<typeof DownloadModelSchema>): TranscribeStatus {
    return this.transcribe.startDownload();
  }

  @Delete('model')
  @ApiOperation({ summary: 'Remove the voice model', description: 'Deletes the downloaded speech model, and answers with the status.' })
  @Responds(TranscribeStatusSchema)
  remove(): Promise<TranscribeStatus> {
    return this.transcribe.removeModel();
  }

  @Post()
  @ApiOperation({ summary: 'Transcribe a recording', description: 'Takes a recording as the request body and answers with its text. Nothing is stored. `words=1` adds the time and confidence of each word.' })
  @ApiConsumes(...AUDIO)
  @ApiBody(AUDIO_BODY)
  @Responds(TranscribeResultSchema, { status: 201 })
  @Fails({ 400: BAD_AUDIO, 409: NO_ENGINE, 413: 'The recording is larger than 100 MB.' })
  async recording(@Req() req: Request, @Query({ schema: TranscribeQuerySchema }) query: z.infer<typeof TranscribeQuerySchema>): Promise<TranscribeResult> {
    const audio = await readBody(req);
    try {
      return await this.transcribe.transcribe(audio, parseLanguage(query.language), query.words === '1' || query.words === 'true');
    } catch (error) {
      return failure(error);
    }
  }

  @Post('stream')
  @HttpCode(200)
  @ApiOperation({ summary: 'Transcribe a recording as a stream', description: 'Takes a recording as the request body and streams server-sent events: `partial` with the newly committed words, then `done` with the whole result, or `error`.' })
  @ApiConsumes(...AUDIO)
  @ApiBody(AUDIO_BODY)
  @Streams(TranscribeStreamEventSchema, 'The stream ends with `done` or `error`.', 'text/event-stream')
  @Fails({ 413: 'The recording is larger than 100 MB.' })
  async stream(@Req() req: Request, @Res() res: Response, @Query({ schema: TranscribeLanguageQuerySchema }) query: z.infer<typeof TranscribeLanguageQuerySchema>): Promise<void> {
    const audio = await readBody(req);
    const send = sseWriter(res, req);
    for await (const event of this.transcribe.streamRecording(audio, parseLanguage(query.language))) send(event);
    res.end();
  }

  @Post('live')
  @ApiOperation({ summary: 'Start a live transcription', description: 'Starts a transcription that takes audio while the person is still speaking, and answers with its id.' })
  @Responds(LiveTranscriptionSchema, { status: 201 })
  async startLive(@Query({ schema: TranscribeLanguageQuerySchema }) query: z.infer<typeof TranscribeLanguageQuerySchema>): Promise<LiveTranscription> {
    return this.transcribe.startLive(parseLanguage(query.language));
  }

  @Post('live/:id/chunk')
  @HttpCode(204)
  @ApiOperation({ summary: 'Send audio to a live transcription', description: 'Appends a few seconds of 16-bit 16 kHz mono PCM to a live transcription.' })
  @ApiParam(LIVE_ID)
  @ApiConsumes('application/octet-stream')
  @ApiBody(PCM_BODY)
  @ApiNoContentResponse({ description: 'The audio is taken.' })
  @Fails({ 409: NO_LIVE, 413: 'The chunk is larger than 4 MB.' })
  async chunk(@Param('id') id: string, @Req() req: Request): Promise<void> {
    this.transcribe.pushLive(id, await readBody(req, 4 * 1024 * 1024));
  }

  @Get('live/:id/events')
  @ApiOperation({ summary: 'Stream a live transcription', description: 'Streams server-sent events while the audio is taken: `partial` with the words committed so far, then `done` or `error`.' })
  @ApiParam(LIVE_ID)
  @Streams(TranscribeStreamEventSchema, 'The stream ends with `done` or `error`.', 'text/event-stream')
  events(@Param('id') id: string, @Req() req: Request, @Res() res: Response): void {
    const send = sseWriter(res, req);
    const off = this.transcribe.watchLive(id, (event) => {
      send(event);
      if (event.type !== 'partial') res.end();
    });
    res.on('close', off);
  }

  @Post('live/:id/end')
  @ApiOperation({ summary: 'End a live transcription', description: 'Ends the audio of a live transcription and answers with the whole text.' })
  @ApiParam(LIVE_ID)
  @Responds(TranscribeResultSchema, { status: 201 })
  @Fails({ 409: NO_LIVE })
  async end(@Param('id') id: string): Promise<TranscribeResult> {
    return this.transcribe.endLive(id);
  }

  @Delete('live/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Abort a live transcription', description: 'Drops a live transcription and its audio without a result.' })
  @ApiParam(LIVE_ID)
  @ApiNoContentResponse({ description: 'The transcription is dropped.' })
  abort(@Param('id') id: string): void {
    this.transcribe.abortLive(id);
  }
}
