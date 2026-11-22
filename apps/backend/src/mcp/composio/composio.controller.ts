import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ComposioAddRequestSchema,
  type ComposioApp,
  ComposioAppSchema,
  type ComposioConnect,
  ComposioConnectSchema,
  type ComposioConnection,
  ComposioConnectionListSchema,
  ComposioConnectionSchema,
  ComposioKeyRequestSchema,
  type ComposioStatus,
  ComposioStatusSchema,
  type ComposioToolkit,
  ComposioToolkitListSchema,
  ComposioToolkitsQuerySchema,
  type ComposioFoundApp,
  ComposioFoundAppListSchema,
  ComposioSearchQuerySchema,
  ComposioWireRequestSchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds } from '../../contract';
import { ComposioConnectService } from './composio-connect.service';
import { ComposioService } from './composio.service';

@ApiTags('connectors')
@Controller('composio')
export class ComposioController {
  constructor(
    private readonly composio: ComposioService,
    private readonly connect: ComposioConnectService,
  ) {}

  @Get('connect')
  @ApiOperation({
    summary: 'Get the apps reached through Composio Connect',
    description:
      'The Composio Connect server (signed in with the browser), whether it is signed in, and the apps chosen for it with whether each has an active account in Composio. Checking changes nothing in Composio.',
  })
  @Responds(ComposioConnectSchema)
  connectState(): Promise<ComposioConnect> {
    return this.connect.state();
  }

  @Post('connect/apps')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Choose an app for Composio Connect',
    description:
      'Remembers the app, so Settings shows its state and room leads are told about it, and asks Composio whether it is connected. No sign-in link is made here; ask for one with the link route.',
  })
  @Responds(ComposioConnectSchema)
  @Fails({ 409: 'There is no Composio Connect server.' })
  wire(
    @Body({ schema: ComposioWireRequestSchema }) body: z.infer<typeof ComposioWireRequestSchema>,
  ): Promise<ComposioConnect> {
    return this.connect.wire(body);
  }

  @Get('connect/search')
  @ApiOperation({
    summary: 'Search apps through Composio Connect',
    description: 'Asks Composio’s own tool search which apps fit a name or a use case. It only reads.',
  })
  @Responds(ComposioFoundAppListSchema)
  @Fails({ 409: 'There is no Composio Connect server.', 502: 'Composio did not answer.' })
  search(
    @Query({ schema: ComposioSearchQuerySchema }) query: z.infer<typeof ComposioSearchQuerySchema>,
  ): Promise<ComposioFoundApp[]> {
    return this.connect.search(query.q);
  }

  @Post('connect/apps/:toolkit/link')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get a page to connect a Composio Connect app',
    description:
      'Asks Composio for a new page where the app is connected in the browser. Each call makes a new link, which works for 10 minutes; an app already connected answers without one.',
  })
  @ApiParam({ name: 'toolkit', description: 'The Composio toolkit slug.', schema: { type: 'string' } })
  @Responds(ComposioAppSchema)
  @Fails({ 404: 'The app is not one of your Composio apps.', 409: 'There is no Composio Connect server.' })
  connectLink(@Param('toolkit') toolkit: string): Promise<ComposioApp> {
    return this.connect.link(toolkit);
  }

  @Delete('connect/apps/:toolkit')
  @ApiOperation({
    summary: 'Forget a Composio Connect app',
    description:
      'pi-kit stops showing the app and naming it to room leads. Its connection stays in your Composio account.',
  })
  @ApiParam({ name: 'toolkit', description: 'The Composio toolkit slug.', schema: { type: 'string' } })
  @Responds(ComposioConnectSchema)
  unwire(@Param('toolkit') toolkit: string): Promise<ComposioConnect> {
    return this.connect.unwire(toolkit);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get the Composio status',
    description: 'Whether a Composio API key is kept, and where. The key itself is never answered.',
  })
  @Responds(ComposioStatusSchema)
  status(): Promise<ComposioStatus> {
    return this.composio.status();
  }

  @Put('key')
  @ApiOperation({
    summary: 'Keep a Composio API key',
    description:
      'Checks the project API key against Composio and keeps it in the credential store. It is never answered or logged.',
  })
  @Responds(ComposioStatusSchema)
  @Fails({ 409: 'Composio refused the key.', 502: 'Composio did not answer.' })
  setKey(
    @Body({ schema: ComposioKeyRequestSchema }) body: z.infer<typeof ComposioKeyRequestSchema>,
  ): Promise<ComposioStatus> {
    return this.composio.setKey(body.apiKey);
  }

  @Delete('key')
  @ApiOperation({ summary: 'Forget the Composio API key', description: 'Removes the kept key.' })
  @Responds(ComposioStatusSchema)
  @Fails({ 409: 'Composio apps still use the key.' })
  forgetKey(): Promise<ComposioStatus> {
    return this.composio.forgetKey();
  }

  @Get('toolkits')
  @ApiOperation({ summary: 'Search Composio apps', description: 'Lists Composio toolkits, most popular first.' })
  @Responds(ComposioToolkitListSchema)
  @Fails({ 409: 'No Composio API key yet.', 502: 'Composio did not answer.' })
  toolkits(
    @Query({ schema: ComposioToolkitsQuerySchema }) query: z.infer<typeof ComposioToolkitsQuerySchema>,
  ): Promise<ComposioToolkit[]> {
    return this.composio.toolkits(query.search);
  }

  @Get('connections')
  @ApiOperation({
    summary: 'List the Composio apps',
    description: 'The Composio apps pi-kit added to the MCP configuration, and whether each is signed in.',
  })
  @Responds(ComposioConnectionListSchema)
  connections(): Promise<ComposioConnection[]> {
    return this.composio.connections();
  }

  @Post('connections')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Add a Composio app',
    description:
      "Creates a Composio session limited to one app (read only unless asked otherwise), adds it to pi's MCP configuration, and answers with the sign-in link the app still needs.",
  })
  @Responds(ComposioConnectionSchema)
  @Fails({ 409: 'No Composio API key yet, or Composio refused it.', 502: 'Composio did not answer.' })
  add(
    @Body({ schema: ComposioAddRequestSchema }) body: z.infer<typeof ComposioAddRequestSchema>,
  ): Promise<ComposioConnection> {
    return this.composio.add(body);
  }

  @Post('connections/:server/link')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in to a Composio app',
    description: 'Answers with a new Composio sign-in link for the app, unless it is signed in already.',
  })
  @ApiParam({ name: 'server', description: 'The server name of the Composio app.', schema: { type: 'string' } })
  @Responds(ComposioConnectionSchema)
  @Fails({ 404: 'pi-kit did not add that app.', 502: 'Composio did not answer.' })
  link(@Param('server') server: string): Promise<ComposioConnection> {
    return this.composio.link(server);
  }
}
