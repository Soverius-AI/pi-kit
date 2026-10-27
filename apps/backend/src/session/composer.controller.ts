import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type CompleteResponse, CompleteRequestSchema, CompleteResponseSchema, type ComposerRegistration, ComposerRegistrationSchema } from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds, ThreadIdParam } from '../contract';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';

/**
 * What the composer asks of the extensions of a thread's pi session: argument completion from the autocomplete
 * providers they added, and the toolbar actions and suggestions they registered. Both open the session first, as the command list does.
 */
@ApiTags('session')
@ThreadIdParam()
@Controller()
export class ComposerController {
  constructor(
    private readonly threads: ThreadsService,
    private readonly sessions: PiSessionService,
  ) {}

  /** `ctx.ui.addAutocompleteProvider`: the suggestions at the caret of a single-line text, each with the text and caret that applying it gives. */
  @Post('threads/:id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete a command argument', description: 'Asks the autocomplete providers that extensions added for the suggestions at the caret, each with the text and caret that applying it gives.' })
  @Responds(CompleteResponseSchema)
  @Fails({ 404: 'There is no such thread.' })
  async complete(@Param('id') id: string, @Body({ schema: CompleteRequestSchema }) body: z.infer<typeof CompleteRequestSchema>): Promise<CompleteResponse> {
    await this.threads.openSession(id);
    return this.sessions.complete(id, body.text, body.cursor);
  }

  /**
   * The registrations that are in force now. They also arrive as `pi.composer` custom events in the thread's replay; this is for a
   * client that is already connected when the session opens, which no replay reaches.
   */
  @Get('threads/:id/composer')
  @ApiOperation({ summary: 'List composer registrations', description: 'Lists the toolbar actions and suggestion pills that extensions registered and that are in force now.' })
  @Responds(ComposerRegistrationSchema, { array: true })
  @Fails({ 404: 'There is no such thread.' })
  async composer(@Param('id') id: string): Promise<ComposerRegistration[]> {
    await this.threads.openSession(id);
    return this.sessions.composerRegistrations(id);
  }
}
