import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TerminalEventSchema, TerminalInfoSchema, TerminalInputSchema, type TerminalInfo, TerminalResizeSchema, TerminalStartSchema } from '@pi-kit/protocol';
import type { Response } from 'express';
import type { z } from 'zod';
import { Fails, Responds, Streams, WorkspaceIdParam } from '../contract';
import { MetaRepository } from '../db/meta.repository';
import { TerminalService } from './terminal.service';

const KEEPALIVE_MS = 20_000;
const NO_FOLDER = 'The folder is not a known project.';
const NO_TERMINAL = 'There is no terminal in this folder.';

/**
 * The terminal panel's backend. Output is newline-delimited JSON over a plain `GET` (the same way `!command`
 * streams, so the bearer token and CORS rules apply unchanged and no WebSocket upgrade has to be
 * authenticated by hand); keystrokes and resizes are small `POST`s.
 */
@ApiTags('terminal')
@WorkspaceIdParam()
@Controller('workspaces/:id/terminal')
export class TerminalController {
  constructor(
    private readonly terminals: TerminalService,
    private readonly meta: MetaRepository,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a terminal', description: "Starts the shell of the project's terminal panel at the given size, or attaches to the one already running, and answers with its details." })
  @Responds(TerminalInfoSchema)
  @Fails({ 404: NO_FOLDER })
  start(@Param('id') id: string, @Body({ schema: TerminalStartSchema }) body: z.infer<typeof TerminalStartSchema>): TerminalInfo {
    const cwd = this.meta.requireWorkspace(id);
    return this.terminals.start(cwd, body.cols, body.rows);
  }

  @Get('stream')
  @ApiOperation({
    summary: 'Stream terminal output',
    description: 'Keeps the connection open and sends newline-delimited JSON: the shell output as `data` lines and `exit` when the shell ends. A blank line every 20 seconds keeps the connection alive.',
  })
  @Streams(TerminalEventSchema, 'The stream ends when the shell exits or the client closes it.')
  @Fails({ 404: NO_FOLDER })
  stream(@Param('id') id: string, @Res() res: Response): void {
    const cwd = this.meta.requireWorkspace(id);
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const off = this.terminals.subscribe(cwd, (event) => {
      if (res.writableEnded) return;
      res.write(`${JSON.stringify(event)}\n`);
      if (event.type === 'exit') res.end();
    });
    if (!off) {
      res.end();
      return;
    }
    const keepalive = setInterval(() => !res.writableEnded && res.write('\n'), KEEPALIVE_MS);
    res.on('close', () => {
      clearInterval(keepalive);
      off();
    });
  }

  @Post('input')
  @HttpCode(204)
  @ApiOperation({ summary: 'Send keystrokes', description: "Writes keystrokes to the project's terminal." })
  @ApiNoContentResponse({ description: 'The input is written.' })
  @Fails({ 404: NO_TERMINAL })
  input(@Param('id') id: string, @Body({ schema: TerminalInputSchema }) body: z.infer<typeof TerminalInputSchema>): void {
    if (!this.terminals.write(this.meta.requireWorkspace(id), body.data)) throw new NotFoundException(NO_TERMINAL);
  }

  @Post('resize')
  @HttpCode(204)
  @ApiOperation({ summary: 'Resize the terminal', description: "Sets the columns and rows of the project's terminal." })
  @ApiNoContentResponse({ description: 'The terminal is resized.' })
  @Fails({ 404: NO_TERMINAL })
  resize(@Param('id') id: string, @Body({ schema: TerminalResizeSchema }) body: z.infer<typeof TerminalResizeSchema>): void {
    if (!this.terminals.resize(this.meta.requireWorkspace(id), body.cols, body.rows)) throw new NotFoundException(NO_TERMINAL);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop the terminal', description: "Ends the shell of the project's terminal." })
  @ApiNoContentResponse({ description: 'The terminal is stopped, or none was running.' })
  @Fails({ 404: NO_FOLDER })
  kill(@Param('id') id: string): void {
    this.terminals.kill(this.meta.requireWorkspace(id));
  }
}
