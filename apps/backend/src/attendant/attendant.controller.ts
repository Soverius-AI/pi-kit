import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  AttendantRunResultSchema,
  AttendantRunSchema,
  type AttendantRunResult,
  type AttendantSettings,
  AttendantSettingsSchema,
  type AttendantStatus,
  AttendantStatusSchema,
  PatchAttendantSettingsSchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds } from '../contract';
import { AttendantService } from './attendant.service';

const SUGGESTION_ID = { name: 'id', description: 'The suggestion id, from `suggestions` of a thread state.', schema: { type: 'integer' } } as const;

/** The attendant's settings, activity and suggestions. */
@ApiTags('attendant')
@Controller('attendant')
export class AttendantController {
  constructor(private readonly attendant: AttendantService) {}

  /** Settings, what it did (newest first, with cost), today's spending and whether the cap is reached. */
  @Get()
  @ApiOperation({ summary: "Get the attendant's status", description: "Returns the attendant's settings, what it did (newest first, with cost), today's spending and whether the cap is reached." })
  @Responds(AttendantStatusSchema)
  status(): Promise<AttendantStatus> {
    return this.attendant.statusReport();
  }

  @Patch('settings')
  @ApiOperation({ summary: "Change the attendant's settings", description: 'Changes the switch, the model, the triggers or the daily cost cap, and answers with the settings.' })
  @Responds(AttendantSettingsSchema)
  patch(@Body({ schema: PatchAttendantSettingsSchema }) body: z.infer<typeof PatchAttendantSettingsSchema>): AttendantSettings {
    return this.attendant.patch(body);
  }

  /** Look at one thread (or at the threads that changed) now; 409 while the attendant is off. Answers with how many were queued. */
  @Post('run')
  @ApiOperation({ summary: 'Run the attendant now', description: 'Looks at one thread, or at the threads that changed, now. Answers 409 while the attendant is off, and with how many threads were queued.' })
  @Responds(AttendantRunResultSchema, { status: 201 })
  @Fails({ 404: 'There is no such thread.', 409: 'The attendant is off.' })
  run(@Body({ schema: AttendantRunSchema }) body: z.infer<typeof AttendantRunSchema>): AttendantRunResult {
    return { queued: this.attendant.run(body.threadId) };
  }

  @Post('suggestions/:id/accept')
  @HttpCode(204)
  @ApiOperation({ summary: 'Accept a suggestion', description: "Applies a label, acknowledges an answer, or consumes a current follow-up prediction for insertion into an editable draft. A follow-up is never sent by this route." })
  @ApiParam(SUGGESTION_ID)
  @ApiNoContentResponse({ description: 'The suggestion is applied.' })
  @Fails({ 404: 'The suggestion is not open.', 409: 'The suggestion could not be applied.' })
  async accept(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.attendant.accept(id);
  }

  @Post('suggestions/:id/dismiss')
  @HttpCode(204)
  @ApiOperation({ summary: 'Dismiss a suggestion', description: 'Drops the suggestion without applying it.' })
  @ApiParam(SUGGESTION_ID)
  @ApiNoContentResponse({ description: 'The suggestion is dropped.' })
  @Fails({ 404: 'The suggestion is not open.' })
  dismiss(@Param('id', ParseIntPipe) id: number): void {
    this.attendant.dismiss(id);
  }
}
