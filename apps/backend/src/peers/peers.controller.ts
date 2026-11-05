import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  PeerConnectSchema,
  PeerConsentSchema,
  PeerInvitationResultSchema,
  PeerManagerSchema,
  RenameEnvironmentSchema,
  WorkspaceSchema,
  type PeerManager,
  type Workspace,
} from '@pi-kit/protocol';
import { Responds } from '../contract';
import { PeersRepository } from '../db/peers.repository';
import { PeersService } from './peers.service';
import { PeerProxy } from './peer-proxy';

@ApiTags('instances')
@Controller('instances')
export class PeersController {
  constructor(
    private readonly peers: PeersService,
    private readonly records: PeersRepository,
    private readonly proxy: PeerProxy,
  ) {}

  static uuid(value: string): string {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new BadRequestException('Expected an instance id.');
    return parsed.data;
  }

  /** The paired device a gateway acts for, if any. */
  static device(req: Request): string | undefined {
    const id = req.headers['x-pi-device-id'];
    if (id === undefined) return undefined;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new ForbiddenException('Invalid device context.');
    return id;
  }

  static owner(req: Request): void {
    if (PeersController.device(req) || req.headers['x-pi-peer-session'])
      throw new ForbiddenException('Instance management requires the trusted owner.');
  }

  @Get()
  @ApiOperation({
    summary: 'List configured instances',
    description: 'Self and reciprocal peers, filtered to the requesting device; this is not tailnet-wide discovery.',
  })
  @Responds(PeerManagerSchema)
  list(@Req() req: Request): PeerManager {
    return this.peers.manager(PeersController.device(req));
  }

  @Post('invitations')
  @ApiOperation({
    summary: 'Invite an instance',
    description:
      'Owner-only, short-lived instance enrollment; creates an OS-protected key only on this explicit action.',
  })
  @Responds(PeerInvitationResultSchema, { status: 201 })
  invite(@Req() req: Request): Promise<{ invitation: string; expiresAt: number }> {
    PeersController.owner(req);
    return this.peers.invitation();
  }

  @Post('connect')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Request reciprocal pairing',
    description:
      'Owner-initiated enrollment bound to the invitation identity; the other owner must approve the matching code.',
  })
  @Responds(PeerManagerSchema)
  async connect(
    @Req() req: Request,
    @Body({ schema: PeerConnectSchema }) body: z.infer<typeof PeerConnectSchema>,
  ): Promise<PeerManager> {
    PeersController.owner(req);
    await this.peers.connect(body.invitation, body.allowRelay);
    return this.peers.manager();
  }

  @Post('requests/:pairId/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve reciprocal control',
    description:
      'Owner explicitly approves both directions and chooses whether approved phones may relay through the pair.',
  })
  @Responds(PeerManagerSchema)
  approve(
    @Req() req: Request,
    @Param('pairId') pairId: string,
    @Body({ schema: PeerConsentSchema }) body: z.infer<typeof PeerConsentSchema>,
  ): PeerManager {
    PeersController.owner(req);
    this.peers.approvePair(PeersController.uuid(pairId), body.allowRelay);
    return this.peers.manager();
  }

  @Delete('requests/:pairId')
  @ApiOperation({
    summary: 'Reject an instance request',
    description: 'Owner rejects pending enrollment without granting access or changing publication.',
  })
  @Responds(PeerManagerSchema)
  reject(@Req() req: Request, @Param('pairId') pairId: string): PeerManager {
    PeersController.owner(req);
    this.peers.reject(PeersController.uuid(pairId));
    return this.peers.manager();
  }

  @Delete(':peerId')
  @ApiOperation({
    summary: 'Unpair an instance',
    description: 'Local access stops immediately and a durable notification is retried if the peer is offline.',
  })
  @Responds(PeerManagerSchema)
  async unpair(@Req() req: Request, @Param('peerId') peerId: string): Promise<PeerManager> {
    PeersController.owner(req);
    await this.peers.unpair(PeersController.uuid(peerId));
    return this.peers.manager();
  }

  @Patch(':peerId')
  @ApiOperation({
    summary: 'Rename a peer locally',
    description: 'Owner changes a display alias, never the peer identity, endpoint or project ownership.',
  })
  @Responds(PeerManagerSchema)
  rename(
    @Req() req: Request,
    @Param('peerId') peerId: string,
    @Body({ schema: RenameEnvironmentSchema }) body: z.infer<typeof RenameEnvironmentSchema>,
  ): PeerManager {
    PeersController.owner(req);
    this.records.rename(PeersController.uuid(peerId), body.name);
    return this.peers.manager();
  }

  @Get(':peerId/projects')
  @ApiOperation({
    summary: 'List projects on a paired instance',
    description:
      'Reads only the selected authorized peer; failures do not replace local projects or change chat targets.',
  })
  @Responds(WorkspaceSchema, { array: true })
  projects(@Req() req: Request, @Param('peerId') peerId: string): Promise<Workspace[]> {
    const controller = new AbortController();
    req.once('close', () => controller.abort());
    return this.proxy.projects(PeersController.uuid(peerId), PeersController.device(req), controller.signal);
  }
}
