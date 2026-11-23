import { Body, Controller, Get, Param, Post, Put, Delete, UseGuards, Header } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ConfirmRoomPhoneSchema,
  RoomPhoneLinkSchema,
  RoomPhoneStatusSchema,
  ReviewRoomPhoneSchema,
  type ConfirmRoomPhone,
  type RoomPhoneLink,
  type RoomPhoneStatus,
  type ReviewRoomPhone,
  RoomPhoneConfigSchema,
  type RoomPhoneConfig,
} from '@pi-kit/protocol';
import { Fails, Remote, Responds } from '../contract';
import { ROOMS_OFF, RoomsEnabledGuard } from './rooms-enabled.guard';
import { NO_ROOM } from './room-lead.service';
import { RoomPhoneService } from './room-phone.service';

@ApiTags('rooms')
@Controller('rooms/:roomId/phone')
@ApiParam({ name: 'roomId', description: 'The hosted room id.' })
@UseGuards(RoomsEnabledGuard)
export class RoomPhoneController {
  constructor(private readonly phone: RoomPhoneService) {}
  @Remote()
  @Put('config')
  @Responds(RoomPhoneStatusSchema)
  @ApiOperation({ summary: 'Set the private phone application URL for room links' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  config(
    @Param('roomId') room: string,
    @Body({ schema: RoomPhoneConfigSchema }) body: RoomPhoneConfig,
  ): Promise<RoomPhoneStatus> {
    return this.phone.config(room, body);
  }
  @Remote()
  @Post('test')
  @Responds(RoomPhoneStatusSchema, { status: 201 })
  @ApiOperation({
    summary: 'Verify an actual phone round trip',
    description:
      'Sends a test to the bound group and requires a reply from its authorized owner. Merely connecting an account is not delivery verification.',
  })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  test(@Param('roomId') room: string): Promise<RoomPhoneStatus> {
    return this.phone.test(room);
  }

  @Remote()
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read the room WhatsApp connection',
    description:
      'Returns a QR for linking a dedicated assistant account, a group binding and queue health. Available only to authenticated paired clients.',
  })
  @Responds(RoomPhoneStatusSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  status(@Param('roomId') roomId: string): Promise<RoomPhoneStatus> {
    return this.phone.status(roomId);
  }

  @Remote()
  @Post('connect')
  @Header('Cache-Control', 'no-store')
  @Responds(RoomPhoneStatusSchema, { status: 201 })
  @ApiOperation({
    summary: 'Connect the host WhatsApp account',
    description:
      'Starts or reconnects the one host-owned assistant account. Sessions are stored in the protected application data directory. A QR appears in status when required.',
  })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}`, 503: 'WhatsApp could not connect.' })
  connect(@Param('roomId') roomId: string): Promise<RoomPhoneStatus> {
    return this.phone.connect(roomId);
  }

  @Remote()
  @Post('disconnect')
  @Responds(RoomPhoneStatusSchema, { status: 201 })
  @ApiOperation({
    summary: 'Disconnect the host WhatsApp account',
    description:
      'Stops the account for all rooms and disables automatic reconnection on startup. Keeps bindings, pending messages and credentials for explicit reconnection. Unlink the device in WhatsApp to revoke its credentials.',
  })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  disconnect(@Param('roomId') roomId: string): Promise<RoomPhoneStatus> {
    return this.phone.disconnect(roomId);
  }

  @Remote()
  @Post('review')
  @Responds(RoomPhoneStatusSchema, { status: 201 })
  @ApiOperation({
    summary: 'Dismiss an uncertain phone item after review',
    description:
      'Acknowledges that the owner reviewed room and WhatsApp history. Does not send a message or execute a turn again; resend manually if necessary.',
  })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  dismiss(
    @Param('roomId') roomId: string,
    @Body({ schema: ReviewRoomPhoneSchema }) body: ReviewRoomPhone,
  ): Promise<RoomPhoneStatus> {
    return this.phone.dismiss(roomId, body);
  }

  @Remote()
  @Post('link')
  @Header('Cache-Control', 'no-store')
  @Responds(RoomPhoneLinkSchema, { status: 201 })
  @ApiOperation({
    summary: 'Start linking a WhatsApp group',
    description:
      'Returns a ten-minute challenge. Send /room-link CODE from the owner account in a group with the assistant. Confirmation in this app is required before accepting messages.',
  })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}`, 409: 'Unlink the existing group first.' })
  begin(@Param('roomId') roomId: string): Promise<RoomPhoneLink> {
    return this.phone.begin(roomId);
  }

  @Remote()
  @Post('confirm')
  @Responds(RoomPhoneStatusSchema, { status: 201 })
  @ApiOperation({
    summary: 'Confirm the group and authorized owner',
    description:
      'Binds the challenge sender and group to this room. Subsequent lead replies, including scheduled replies, go to that group. Other group members cannot command the room. Room pause/archive suspends processing and delivery.',
  })
  @Fails({
    404: `${ROOMS_OFF} Or: ${NO_ROOM}`,
    409: 'The challenge expired or changed, or the group is already bound.',
  })
  confirm(
    @Param('roomId') roomId: string,
    @Body({ schema: ConfirmRoomPhoneSchema }) body: ConfirmRoomPhone,
  ): Promise<RoomPhoneStatus> {
    return this.phone.confirm(roomId, body);
  }

  @Remote()
  @Delete()
  @Responds(RoomPhoneStatusSchema)
  @ApiOperation({
    summary: 'Unlink the room WhatsApp group',
    description:
      'Revokes this room binding and clears pending phone messages and deliveries. Room history and the host account session remain.',
  })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  unlink(@Param('roomId') roomId: string): Promise<RoomPhoneStatus> {
    return this.phone.unlink(roomId);
  }
}
