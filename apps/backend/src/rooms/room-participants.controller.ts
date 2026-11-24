import { Body, Controller, Delete, Get, Header, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  RoomParticipantsSchema,
  RoomParticipantInputSchema,
  RoomParticipantTargetsSchema,
  type RoomParticipants,
  type RoomParticipantInput,
  type RoomParticipantTargets,
} from '@pi-kit/protocol';
import { Remote, Responds, Fails } from '../contract';
import { RoomsEnabledGuard } from './rooms-enabled.guard';
import { RoomParticipants as Participants } from './room-participants.service';

@ApiTags('rooms')
@Controller('rooms/:roomId/participants')
@ApiParam({ name: 'roomId', description: 'The hosted room id.' })
@UseGuards(RoomsEnabledGuard)
export class RoomParticipantsController {
  constructor(private readonly participants: Participants) {}
  @Remote()
  @Get()
  @Header('Cache-Control', 'no-store')
  @Responds(RoomParticipantsSchema)
  @ApiOperation({
    summary: 'List effective room collaborators',
    description:
      'Returns all room-local and inherited playbook collaborators. Room roles override matching inherited roles without truncating the roster. Does not create a lead thread.',
  })
  @Fails({ 404: 'No room with this id.' })
  list(@Param('roomId') room: string): Promise<RoomParticipants> {
    return this.participants.list(room);
  }
  @Remote()
  @Get('targets')
  @Header('Cache-Control', 'no-store')
  @Responds(RoomParticipantTargetsSchema)
  @ApiOperation({
    summary: 'List collaborator targets on this room’s host',
    description:
      'Lists this host, paired computers with readiness, and registered external A2A agents. Credentials are never returned.',
  })
  targets(@Param('roomId') room: string): Promise<RoomParticipantTargets> {
    return this.participants.targets(room);
  }
  @Remote()
  @Post()
  @Responds(RoomParticipantsSchema, { status: 201 })
  @ApiOperation({
    summary: 'Add a room collaborator without requiring a playbook',
    description:
      'Adds a unique room-local role targeting a local model, paired computer, or registered external agent.',
  })
  add(
    @Param('roomId') room: string,
    @Body({ schema: RoomParticipantInputSchema }) input: RoomParticipantInput,
  ): Promise<RoomParticipants> {
    return this.participants.add(room, input);
  }
  @Remote()
  @Put(':role')
  @ApiParam({
    name: 'role',
    description: 'The current collaborator role.',
    schema: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' },
  })
  @Responds(RoomParticipantsSchema)
  @ApiOperation({
    summary: 'Edit a room collaborator or override an inherited role',
    description:
      'Updates or renames a role in this room, retaining the shared playbook unchanged. Future consultations use the new settings.',
  })
  update(
    @Param('roomId') room: string,
    @Param('role') role: string,
    @Body({ schema: RoomParticipantInputSchema }) input: RoomParticipantInput,
  ): Promise<RoomParticipants> {
    return this.participants.update(room, role, input);
  }
  @Remote()
  @Delete(':role')
  @ApiParam({
    name: 'role',
    description: 'The collaborator role to remove from this room.',
    schema: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' },
  })
  @Responds(RoomParticipantsSchema)
  @ApiOperation({
    summary: 'Remove a collaborator from this room without unregistering its external service',
    description:
      'Removes the room-local role or hides an inherited playbook role in this room. External agent registration is retained.',
  })
  remove(@Param('roomId') room: string, @Param('role') role: string): Promise<RoomParticipants> {
    return this.participants.remove(room, role);
  }
}
