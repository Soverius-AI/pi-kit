import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  type Installing,
  InstallingSchema,
  PinReleaseSchema,
  type Releases,
  ReleasesSchema,
  type Restarting,
  RestartingSchema,
  type UpdateEvent,
  UpdateEventSchema,
  UpdateRequestSchema,
  type UpdateStatus,
  UpdateStatusSchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds, Streams } from '../contract';
import { UpdateService } from './update.service';

/**
 * Updates from inside the app. `POST /api/update` starts the one background job for the given targets;
 * `GET /api/update/status` is the state of every row, `GET /api/update/events` streams it (one JSON object per line: status snapshots and
 * the job's output lines), `POST /api/update/check` looks again.
 */
@ApiTags('update')
@Controller('update')
export class UpdateController {
  constructor(private readonly updates: UpdateService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get the update status', description: 'Returns one row per target (pi, its packages, the model catalogs, the app) with what is installed and what is newer, and the running job if there is one.' })
  @Responds(UpdateStatusSchema)
  status(): UpdateStatus {
    return this.updates.status();
  }

  @Post('check')
  @ApiOperation({ summary: 'Check for updates', description: 'Looks again for newer releases, ignoring the cache, and answers with the status.' })
  @Responds(UpdateStatusSchema, { status: 201 })
  check(): Promise<UpdateStatus> {
    return this.updates.check(true);
  }

  @Post()
  @ApiOperation({ summary: 'Start an update', description: 'Starts the one background job that updates the given targets, and answers with the status. Progress is streamed from `update/events`.' })
  @Responds(UpdateStatusSchema, { status: 201 })
  @Fails({ 409: 'An update is already running.' })
  start(@Body({ schema: UpdateRequestSchema }) body: z.infer<typeof UpdateRequestSchema>): UpdateStatus {
    return this.updates.start(body.targets);
  }

  @Post('cancel')
  @ApiOperation({ summary: 'Cancel the update', description: 'Stops the running update job, and answers with the status.' })
  @Responds(UpdateStatusSchema, { status: 201 })
  cancel(): UpdateStatus {
    return this.updates.cancel();
  }

  /** "Restart to use …": the backend ends itself and the watchdog starts it again (Settings and the toast call this after an update). */
  @Post('restart')
  @ApiOperation({ summary: 'Restart the backend', description: 'Ends the backend, and the watchdog starts it again with the newer pi. Settings and the toast call this after an update.' })
  @Responds(RestartingSchema, { status: 201 })
  @Fails({ 409: 'Nothing restarts the backend here: restart it yourself.' })
  restart(): Restarting {
    this.updates.restart();
    return { restarting: true };
  }

  /** pi-kit's own update, downloaded earlier: Electron main installs it and relaunches. */
  @Post('install-app')
  @ApiOperation({ summary: 'Install the app update', description: "Installs the update of pi-kit itself that was downloaded earlier: the desktop app quits, installs it and relaunches." })
  @Responds(InstallingSchema, { status: 201 })
  @Fails({ 409: 'No update of the app has been downloaded.' })
  async installApp(): Promise<Installing> {
    await this.updates.installApp();
    return { installing: true };
  }

  @Post('install-command')
  @ApiOperation({ summary: 'Put the managed pi on PATH', description: 'Installs a `pi` launcher on PATH that runs the managed install, so the terminal and the app run the same pi, and answers with the status.' })
  @Responds(UpdateStatusSchema, { status: 201 })
  @Fails({ 409: 'There is no managed pi install yet: update pi first.' })
  installCommand(): UpdateStatus {
    return this.updates.installCommand();
  }

  @Get('releases')
  @ApiOperation({ summary: 'List managed releases', description: 'Lists the managed pi releases "Use previous release" offers, and the one that is pinned.' })
  @Responds(ReleasesSchema)
  releases(): Releases {
    return this.updates.releases();
  }

  /** "Use previous release": `{ release: "1.3.0" | "bundled" | null }`; takes effect at the next start. */
  @Post('pin')
  @ApiOperation({ summary: 'Pin a pi release', description: 'Pins pi to a managed release, or to `bundled`, or with `null` follows the newest again. It takes effect at the next start. Answers with the status.' })
  @Responds(UpdateStatusSchema, { status: 201 })
  @Fails({ 409: 'That release is not one of the managed releases, or there is no managed install.' })
  pin(@Body({ schema: PinReleaseSchema }) body: z.infer<typeof PinReleaseSchema>): UpdateStatus {
    return this.updates.pin(body.release);
  }

  @Get('events')
  @ApiOperation({
    summary: 'Stream update progress',
    description: 'Keeps the connection open and sends newline-delimited JSON: a `status` snapshot first and whenever it changes, and the output lines of the running job as `line`. A blank line every 20 seconds keeps the connection alive.',
  })
  @Streams(UpdateEventSchema, 'The stream stays open until the client closes it.')
  events(@Res() res: Response): void {
    res.status(200).set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event: UpdateEvent): void => void res.write(`${JSON.stringify(event)}\n`);
    send({ type: 'status', status: this.updates.status() });
    const off = this.updates.subscribe(send);
    const beat = setInterval(() => res.write('\n'), 20_000);
    res.on('close', () => {
      off();
      clearInterval(beat);
    });
  }
}
