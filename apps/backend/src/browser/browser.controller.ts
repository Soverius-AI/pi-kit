import { Body, Controller, Get, Param, Post, UseFilters } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BrowserActionSchema, BrowserResultSchema, BrowserStateSchema, type BrowserAction, type BrowserResult, type BrowserState } from '@pi-kit/protocol';
import { Responds, ThreadIdParam } from '../contract';
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
  @ApiOperation({ summary: 'Get the browser artifact', description: 'The current page of this chat. Available only when the desktop app hosts the backend.' })
  @Responds(BrowserStateSchema)
  state(@Param('id') id: string): Promise<BrowserState> { return this.browser.state(id); }

  @Post('action')
  @ApiOperation({ summary: 'Use the browser artifact', description: 'Navigate or inspect the same isolated browser page the user sees in Artifacts. Element references come from a recent accessibility snapshot.' })
  @Responds(BrowserResultSchema, { status: 201 })
  action(@Param('id') id: string, @Body({ schema: BrowserActionSchema }) action: BrowserAction): Promise<BrowserResult> { return this.browser.run(id, action); }
}
