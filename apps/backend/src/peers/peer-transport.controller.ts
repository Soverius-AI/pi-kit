import { All, Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  isRemoteApiPath,
  isReviewedRemoteApi,
  PeerChallengeRequestSchema,
  PeerPairProofSchema,
  PeerPairRequestSchema,
  PeerSessionRequestSchema,
} from '@pi-kit/protocol';
import { PeerSessions } from './peer-sessions';
import { PeersService } from './peers.service';
import { PeerProxy } from './peer-proxy';
import { PeersController } from './peers.controller';
import { InstanceRepository } from '../db/instance.repository';

const AuthorizeSchema = z
  .object({ token: z.string().max(128).meta({ secret: true }), path: z.string().max(8192), method: z.string().max(10) })
  .strict();

/**
 * Private transport RPC, like the AG-UI transport rather than the generated renderer REST API.
 * Global master authentication still applies. The instance HTTPS boundary forwards only these exact RPCs,
 * bounds their bodies, and each RPC independently checks a pinned signature/grant or session.
 * Credential-issuance responses intentionally go only to the authenticated peer, never a renderer DTO.
 */
@ApiExcludeController()
@Controller('peer')
export class PeerTransportController {
  constructor(
    private readonly peers: PeersService,
    private readonly sessions: PeerSessions,
  ) {}
  @Get('identity')
  identity(): ReturnType<PeersService['metadata']> {
    return this.peers.metadata();
  }
  @Post('pair/request')
  @HttpCode(200)
  request(@Body({ schema: PeerPairRequestSchema }) body: z.infer<typeof PeerPairRequestSchema>): Promise<unknown> {
    return this.peers.request(body);
  }
  @Post('pair/status')
  @HttpCode(200)
  status(@Body({ schema: PeerPairProofSchema }) body: z.infer<typeof PeerPairProofSchema>): Promise<unknown> {
    return this.peers.status(body.pairId, body.proof);
  }
  @Post('pair/ack')
  @HttpCode(200)
  ack(@Body({ schema: PeerPairProofSchema }) body: z.infer<typeof PeerPairProofSchema>): Promise<{ paired: true }> {
    return this.peers.acknowledge(body.pairId, body.proof);
  }
  @Post('unpair')
  @HttpCode(200)
  unpair(
    @Body({ schema: PeerPairProofSchema }) body: z.infer<typeof PeerPairProofSchema>,
  ): Promise<{ unpaired: true }> {
    return this.peers.remoteUnpair(body.pairId, body.proof);
  }
  @Post('challenge')
  @HttpCode(200)
  challenge(
    @Body({ schema: PeerChallengeRequestSchema }) body: z.infer<typeof PeerChallengeRequestSchema>,
  ): ReturnType<PeerSessions['challenge']> {
    return this.sessions.challenge(body.peerId);
  }
  @Post('session')
  @HttpCode(200)
  session(
    @Body({ schema: PeerSessionRequestSchema }) body: z.infer<typeof PeerSessionRequestSchema>,
  ): Promise<unknown> {
    return this.sessions.session(body);
  }
  @Post('authorize')
  @HttpCode(200)
  authorize(@Body({ schema: AuthorizeSchema }) body: z.infer<typeof AuthorizeSchema>): { allowed: boolean } {
    this.sessions.authorize(body.token);
    return { allowed: isRemoteApiPath(body.path) && isReviewedRemoteApi(body.path, body.method) };
  }
}

/** Opaque streaming wrappers preserve the generated operations' inner paths, status and replay framing. */
@ApiExcludeController()
@Controller('instances/:peerId/proxy')
export class OutgoingPeerProxyController {
  constructor(
    private readonly proxy: PeerProxy,
    private readonly instance: InstanceRepository,
  ) {}
  @All('*path')
  async forward(@Param('peerId') peerId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const prefix = /^\/api\/instances\/[^/]+\/proxy/.exec(req.originalUrl)?.[0];
    if (!prefix) {
      res.status(400).end();
      return;
    }
    const id = PeersController.uuid(peerId),
      path = req.originalUrl.slice(prefix.length);
    // An explicit owner ref also works while cold-start metadata is offline. Never reinterpret a different UUID as local.
    if (id === this.instance.instanceId) await this.proxy.self(path, req, res);
    else await this.proxy.remote(id, PeersController.device(req), path, req, res);
  }
}

@ApiExcludeController()
@Controller('peer/api')
export class IncomingPeerProxyController {
  constructor(private readonly proxy: PeerProxy) {}
  @All('*path')
  async forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    const prefix = '/api/peer/api',
      token = req.headers['x-pi-peer-session'];
    await this.proxy.incoming(typeof token === 'string' ? token : '', req.originalUrl.slice(prefix.length), req, res);
  }
}
