import { Body, Controller, Get, Param, Post, Req, UseFilters } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  BrowserActionSchema,
  BrowserResultSchema,
  BrowserStateSchema,
  type BrowserAction,
  type BrowserResult,
  type BrowserState,
} from '@pi-kit/protocol';
import { Responds, ThreadIdParam } from '../contract';
import { PeersController } from '../peers/peers.controller';
import { BrowserService } from './browser.service';
import { BrowserExceptionFilter } from './browser-exception.filter';

/**
 * The browser artifact of a thread (`threads/:id/browser`): the page it shows, and the actions that navigate or
 * inspect it.
 */
@ApiTags('browser')
@ThreadIdParam()
@Controller('threads/:id/browser')
@UseFilters(BrowserExceptionFilter)
export class BrowserController {
  constructor(private readonly browser: BrowserService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the browser artifact',
    description: 'The current page of this chat. Available only when the desktop app hosts the backend.',
  })
  @Responds(BrowserStateSchema)
  state(@Param('id') id: string): Promise<BrowserState> {
    return this.browser.state(id);
  }

  @Post('action')
  @ApiOperation({
    summary: 'Use the browser artifact',
    description:
      'Navigate or inspect the same isolated browser page the user sees in Artifacts. Element references come from a recent accessibility snapshot.',
  })
  @Responds(BrowserResultSchema, { status: 201 })
  action(
    @Param('id') id: string,
    @Body({ schema: BrowserActionSchema }) action: BrowserAction,
  ): Promise<BrowserResult> {
    return this.browser.run(id, action);
  }
}

/**
 * The browser artifact of a thread that lives on a paired instance (`instances/:peerId/threads/:id/browser`). The page is a native
 * view of this desktop, so it is served here and never proxied; only the trusted owner may use it, never a phone or a peer.
 */
@ApiTags('browser')
@ThreadIdParam()
@ApiParam({ name: 'peerId', description: 'The paired instance that owns the thread.', schema: { type: 'string' } })
@Controller('instances/:peerId/threads/:id/browser')
@UseFilters(BrowserExceptionFilter)
export class PeerBrowserController {
  constructor(private readonly browser: BrowserService) {}

  @Get()
  @ApiOperation({
    summary: "Get the browser artifact of a paired instance's thread",
    description: 'The page this desktop shows for that thread. Available only when the desktop app hosts the backend.',
  })
  @Responds(BrowserStateSchema)
  state(@Req() req: Request, @Param('peerId') peerId: string, @Param('id') id: string): Promise<BrowserState> {
    PeersController.owner(req);
    return this.browser.peerState(PeersController.uuid(peerId), id);
  }

  @Post('action')
  @ApiOperation({
    summary: "Use the browser artifact of a paired instance's thread",
    description:
      "Navigate or inspect that page. A loopback address opens at the paired computer's tailnet name; the server must listen there.",
  })
  @Responds(BrowserResultSchema, { status: 201 })
  action(
    @Req() req: Request,
    @Param('peerId') peerId: string,
    @Param('id') id: string,
    @Body({ schema: BrowserActionSchema }) action: BrowserAction,
  ): Promise<BrowserResult> {
    PeersController.owner(req);
    return this.browser.peerRun(PeersController.uuid(peerId), id, action);
  }
}
