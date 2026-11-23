import { Body, Controller, Get, Post, Put, Patch, Delete, Param, UseGuards, Query } from '@nestjs/common';
import { RoomFileSchema, RoomFileQuerySchema, type RoomFile } from '@pi-kit/protocol';
import { ApiTags, ApiParam, ApiOperation } from '@nestjs/swagger';
import { z } from 'zod';
import {
  RoomAssistantStatusSchema,
  RoomAssistantPolicySchema,
  RoomCommitmentInputSchema,
  RoomCommitmentSchema,
  ChangeRoomCommitmentSchema,
  RoomFolderInputSchema,
  RoomFactInputSchema,
  type RoomAssistantStatus,
  type RoomAssistantPolicy,
  type RoomCommitmentInput,
  type RoomCommitment,
  type ChangeRoomCommitment,
  type RoomFolderInput,
  type RoomFactInput,
} from '@pi-kit/protocol';
import { Remote, Responds, Fails } from '../contract';
import { RoomsEnabledGuard, ROOMS_OFF } from './rooms-enabled.guard';
import { RoomAssistant } from './room-assistant.service';
import { NO_ROOM } from './room-lead.service';
const WorkDecision = z.object({ retry: z.boolean() }).strict().meta({ id: 'RoomWorkDecision' });

@ApiTags('rooms')
@Controller('rooms/:roomId/assistant')
@ApiParam({ name: 'roomId', description: 'The hosted room id.' })
@UseGuards(RoomsEnabledGuard)
export class RoomAssistantController {
  constructor(private readonly assistant: RoomAssistant) {}
  @Remote()
  @Get()
  @Responds(RoomAssistantStatusSchema)
  @ApiOperation({ summary: 'Read room assistant state' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  status(@Param('roomId') id: string): Promise<RoomAssistantStatus> {
    return this.assistant.status(id);
  }
  @Remote()
  @Get('file')
  @Responds(RoomFileSchema)
  @ApiOperation({ summary: 'Download an owned room upload or output' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  file(
    @Param('roomId') id: string,
    @Query({ schema: RoomFileQuerySchema }) query: z.infer<typeof RoomFileQuerySchema>,
  ): Promise<RoomFile> {
    return this.assistant.file(id, query.path);
  }
  @Remote()
  @Put('policy')
  @Responds(RoomAssistantStatusSchema)
  @ApiOperation({ summary: 'Set proactive execution and notification policy' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  policy(
    @Param('roomId') id: string,
    @Body({ schema: RoomAssistantPolicySchema }) body: RoomAssistantPolicy,
  ): Promise<RoomAssistantStatus> {
    return this.assistant.policy(id, body);
  }
  @Remote()
  @Put('memory')
  @Responds(RoomAssistantStatusSchema)
  @ApiOperation({
    summary: 'Remember, correct or forget a fact',
    description: 'An empty text forgets the key. Facts belong only to this room; they do not require a playbook.',
  })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  memory(
    @Param('roomId') id: string,
    @Body({ schema: RoomFactInputSchema }) body: RoomFactInput,
  ): Promise<RoomAssistantStatus> {
    return this.assistant.remember(id, body);
  }
  @Remote()
  @Post('commitments')
  @Responds(RoomCommitmentSchema, { status: 201 })
  @ApiOperation({ summary: 'Create a commitment or daily routine' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  create(
    @Param('roomId') id: string,
    @Body({ schema: RoomCommitmentInputSchema }) body: RoomCommitmentInput,
  ): Promise<RoomCommitment> {
    return this.assistant.create(id, body);
  }
  @Remote()
  @Patch('commitments/:id')
  @Responds(RoomAssistantStatusSchema)
  @ApiParam({ name: 'id', description: 'The commitment id.' })
  @ApiOperation({ summary: 'Complete, cancel or snooze a commitment' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  change(
    @Param('roomId') room: string,
    @Param('id') id: string,
    @Body({ schema: ChangeRoomCommitmentSchema }) body: ChangeRoomCommitment,
  ): Promise<RoomAssistantStatus> {
    return this.assistant.change(room, id, body);
  }
  @Remote()
  @Post('folders')
  @Responds(RoomAssistantStatusSchema, { status: 201 })
  @ApiOperation({ summary: 'Attach a host folder as a read-only room link' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}`, 409: 'The room is busy or the alias already exists.' })
  folder(
    @Param('roomId') id: string,
    @Body({ schema: RoomFolderInputSchema }) body: RoomFolderInput,
  ): Promise<RoomAssistantStatus> {
    return this.assistant.addFolder(id, body);
  }
  @Remote()
  @Delete('folders/:id')
  @Responds(RoomAssistantStatusSchema)
  @ApiParam({ name: 'id', description: 'The attachment id.' })
  @ApiOperation({
    summary: 'Remove a link and revoke its grant',
    description: 'Never deletes target contents. The room agents must finish before grants change.',
  })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}`, 409: 'The room is busy.' })
  removeFolder(@Param('roomId') room: string, @Param('id') id: string): Promise<RoomAssistantStatus> {
    return this.assistant.removeFolder(room, id);
  }
  @Remote()
  @Post('work/:id')
  @Responds(RoomAssistantStatusSchema, { status: 201 })
  @ApiParam({ name: 'id', description: 'The work item id.' })
  @ApiOperation({
    summary: 'Review interrupted work',
    description:
      'retry=true explicitly retries a failed/interrupted turn after the owner reviewed its effects. retry=false dismisses it without repeating any action.',
  })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}`, 409: 'The item cannot be retried.' })
  work(
    @Param('roomId') room: string,
    @Param('id') id: string,
    @Body({ schema: WorkDecision }) body: z.infer<typeof WorkDecision>,
  ): Promise<RoomAssistantStatus> {
    return this.assistant.work(room, id, body.retry);
  }
}
