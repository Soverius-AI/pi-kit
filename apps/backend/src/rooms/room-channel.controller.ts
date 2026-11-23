import { Body, Controller, Delete, Get, Header, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  RoomChannelSchema,
  RoomChannelStatusSchema,
  RoomChannelSettingsSchema,
  RoomPhoneConfigSchema,
  RoomPhoneLinkSchema,
  ConfirmRoomPhoneSchema,
  ReviewRoomPhoneSchema,
  type RoomChannelStatus,
  type RoomChannelSettings,
  type RoomPhoneConfig,
  type RoomPhoneLink,
  type ConfirmRoomPhone,
  type ReviewRoomPhone,
} from '@pi-kit/protocol';
import { Fails, Remote, Responds } from '../contract';
import { RoomsEnabledGuard, ROOMS_OFF } from './rooms-enabled.guard';
import { NO_ROOM } from './room-lead.service';
import { RoomChannelRegistry } from './room-channel.registry';

@ApiTags('rooms')
@Controller('rooms/:roomId/channels/:channel')
@ApiParam({ name: 'roomId', description: 'The hosted room id.' })
@ApiParam({ name: 'channel', enum: ['whatsapp', 'signal', 'slack', 'telegram'] })
@UseGuards(RoomsEnabledGuard)
export class RoomChannelController {
  constructor(private readonly channels: RoomChannelRegistry) {}
  @Remote()
  @Get()
  @Header('Cache-Control', 'no-store')
  @Responds(RoomChannelStatusSchema)
  @ApiOperation({ summary: 'Read a room messaging channel' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  status(@Param('roomId') room: string, @Param('channel') value: string): Promise<RoomChannelStatus> {
    return this.channels.status(RoomChannelSchema.parse(value), room);
  }
  @Remote()
  @Post('connect')
  @Responds(RoomChannelStatusSchema, { status: 201 })
  @ApiOperation({ summary: 'Connect a messaging channel' })
  async connect(@Param('roomId') room: string, @Param('channel') value: string): Promise<RoomChannelStatus> {
    const channel = RoomChannelSchema.parse(value);
    await this.channels.get(channel).connect(room);
    return this.channels.status(channel, room);
  }
  @Remote()
  @Post('disconnect')
  @Responds(RoomChannelStatusSchema, { status: 201 })
  @ApiOperation({ summary: 'Disconnect a messaging channel' })
  async disconnect(@Param('roomId') room: string, @Param('channel') value: string): Promise<RoomChannelStatus> {
    const channel = RoomChannelSchema.parse(value);
    await this.channels.get(channel).disconnect(room);
    return this.channels.status(channel, room);
  }
  @Remote()
  @Post('link')
  @Responds(RoomPhoneLinkSchema, { status: 201 })
  @ApiOperation({ summary: 'Start linking a room conversation' })
  begin(@Param('roomId') room: string, @Param('channel') value: string): Promise<RoomPhoneLink> {
    return this.channels.get(RoomChannelSchema.parse(value)).begin(room);
  }
  @Remote()
  @Post('confirm')
  @Responds(RoomChannelStatusSchema, { status: 201 })
  @ApiOperation({ summary: 'Confirm a conversation and its authorized owner' })
  async confirm(
    @Param('roomId') room: string,
    @Param('channel') value: string,
    @Body({ schema: ConfirmRoomPhoneSchema }) body: ConfirmRoomPhone,
  ): Promise<RoomChannelStatus> {
    const channel = RoomChannelSchema.parse(value);
    await this.channels.get(channel).confirm(room, body);
    return this.channels.status(channel, room);
  }
  @Remote()
  @Delete()
  @Responds(RoomChannelStatusSchema)
  @ApiOperation({ summary: 'Unlink a room conversation' })
  async unlink(@Param('roomId') room: string, @Param('channel') value: string): Promise<RoomChannelStatus> {
    const channel = RoomChannelSchema.parse(value);
    await this.channels.get(channel).unlink(room);
    return this.channels.status(channel, room);
  }
  @Remote()
  @Put('config')
  @Responds(RoomChannelStatusSchema)
  @ApiOperation({ summary: 'Set this channel binding application URL' })
  async config(
    @Param('roomId') room: string,
    @Param('channel') value: string,
    @Body({ schema: RoomPhoneConfigSchema }) body: RoomPhoneConfig,
  ): Promise<RoomChannelStatus> {
    const channel = RoomChannelSchema.parse(value);
    await this.channels.get(channel).config(room, body);
    return this.channels.status(channel, room);
  }
  @Remote()
  @Put('settings')
  @Responds(RoomChannelStatusSchema)
  @ApiOperation({ summary: 'Configure provider credentials or local dependencies' })
  async settings(
    @Param('roomId') room: string,
    @Param('channel') value: string,
    @Body({ schema: RoomChannelSettingsSchema }) body: RoomChannelSettings,
  ): Promise<RoomChannelStatus> {
    const channel = RoomChannelSchema.parse(value);
    await this.channels.get(channel).configure(room, body.values);
    return this.channels.status(channel, room);
  }
  @Remote()
  @Post('test')
  @Responds(RoomChannelStatusSchema, { status: 201 })
  @ApiOperation({ summary: 'Verify an actual messaging round trip' })
  async test(@Param('roomId') room: string, @Param('channel') value: string): Promise<RoomChannelStatus> {
    const channel = RoomChannelSchema.parse(value);
    await this.channels.get(channel).test(room);
    return this.channels.status(channel, room);
  }
  @Remote()
  @Post('review')
  @Responds(RoomChannelStatusSchema, { status: 201 })
  @ApiOperation({ summary: 'Dismiss a reviewed uncertain channel item' })
  async dismiss(
    @Param('roomId') room: string,
    @Param('channel') value: string,
    @Body({ schema: ReviewRoomPhoneSchema }) body: ReviewRoomPhone,
  ): Promise<RoomChannelStatus> {
    const channel = RoomChannelSchema.parse(value);
    await this.channels.get(channel).dismiss(room, body);
    return this.channels.status(channel, room);
  }
}
