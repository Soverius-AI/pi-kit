import { existsSync } from 'node:fs';
import { Body, Controller, Delete, Get, Header, HttpCode, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  type McpActionResult,
  McpActionResultSchema,
  type McpCheckRequest,
  McpCheckRequestSchema,
  type McpCheckResult,
  McpCheckResultSchema,
  McpEnabledRequestSchema,
  type McpFile,
  type McpFilePut,
  McpFilePutSchema,
  type McpFileRequest,
  McpFileRequestSchema,
  type McpFileSaved,
  McpFileSavedSchema,
  type McpFileScopeQuery,
  McpFileScopeQuerySchema,
  McpFileSchema,
  type McpOverview,
  McpOverviewSchema,
  type McpServerBody,
  McpServerBodySchema,
  type McpServerCreate,
  McpServerCreateSchema,
  type McpServerDetail,
  McpServerDetailSchema,
  type McpServerQuery,
  McpServerQuerySchema,
  type OpenPathResult,
  OpenPathResultSchema,
  OptionalThreadQuerySchema,
  SignInPasteRequestSchema,
  ThreadQuerySchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Public } from '../app/auth.guard';
import { Fails, Responds } from '../contract';
import { DesktopBridge } from '../desktop/desktop-bridge';
import { ConnectorsService } from './connectors.service';
import { checkCommand, checkUrl } from './mcp-check';
import { McpEditService } from './mcp-edit.service';
import { McpService } from './mcp.service';
import { SANDBOX_PROXY_CSP, SANDBOX_PROXY_HTML } from './mcp-sandbox';

const SERVER_NAME = { name: 'name', description: 'The name of the MCP server, as configured.', schema: { type: 'string' } } as const;
const NO_SERVER = 'No MCP server with that name is configured.';
const NOT_IDLE = 'A run holds the thread: stop it first.';

/** The MCP panel. Every action names the thread whose pi session it applies to (`?thread=`). */
@ApiTags('mcp')
@Controller()
export class McpController {
  constructor(
    private readonly mcp: McpService,
    private readonly edit: McpEditService,
    private readonly connectors: ConnectorsService,
    private readonly desktop: DesktopBridge,
  ) {}

  @Get('mcp')
  @ApiOperation({ summary: 'List MCP servers', description: "Lists the MCP servers of pi's configuration and, with `thread`, their connection state in that thread's session." })
  @Responds(McpOverviewSchema)
  overview(@Query({ schema: OptionalThreadQuerySchema }) query: z.infer<typeof OptionalThreadQuerySchema>): Promise<McpOverview> {
    return this.mcp.overview(query.thread || undefined);
  }

  /** The reachability check of the "Add a server" wizard: one MCP `initialize` for a URL, a PATH lookup for a command. Nothing is written. */
  @Post('mcp/check')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check that a server answers', description: 'Asks a URL for an MCP `initialize` (and its tools), or looks a command up on the PATH, before the server is added. Nothing is written and the command is not run.' })
  @Responds(McpCheckResultSchema)
  async check(@Body({ schema: McpCheckRequestSchema }) body: McpCheckRequest): Promise<McpCheckResult> {
    if (body.url) return checkUrl(body.url, body.token);
    const program = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(body.command ?? '');
    return checkCommand(program?.[1] ?? program?.[2] ?? program?.[3] ?? '');
  }

  /** "Open in editor" of The files group: the desktop app opens the file with the system's default application. */
  @Post('mcp/files/open')
  @HttpCode(200)
  @ApiOperation({ summary: 'Open an mcp.json in the editor', description: "Asks the desktop app to open the user's `mcp.json`, or the project's with `thread`, with the system's default application." })
  @Responds(OpenPathResultSchema)
  @Fails({ 404: 'The file does not exist yet.' })
  async openFile(@Query({ schema: OptionalThreadQuerySchema }) query: z.infer<typeof OptionalThreadQuerySchema>, @Body({ schema: McpFileRequestSchema }) body: McpFileRequest): Promise<OpenPathResult> {
    return this.desktop.openPath(await this.existingFile(body.scope, query.thread || undefined));
  }

  @Post('mcp/files/reveal')
  @HttpCode(200)
  @ApiOperation({ summary: 'Show an mcp.json in the file manager', description: "Asks the desktop app to show the user's `mcp.json`, or the project's with `thread`, in the system file manager." })
  @Responds(OpenPathResultSchema)
  @Fails({ 404: 'The file does not exist yet.' })
  async revealFile(@Query({ schema: OptionalThreadQuerySchema }) query: z.infer<typeof OptionalThreadQuerySchema>, @Body({ schema: McpFileRequestSchema }) body: McpFileRequest): Promise<OpenPathResult> {
    return this.desktop.revealPath(await this.existingFile(body.scope, query.thread || undefined));
  }

  private async existingFile(scope: McpFileRequest['scope'], thread: string | undefined): Promise<string> {
    const path = await this.mcp.filePath(scope, thread);
    if (!existsSync(path)) throw new NotFoundException(`${path} does not exist yet: it is created when the first server is added.`);
    return path;
  }

  // ---- editing: the details form and the file editor

  @Get('mcp/file')
  @ApiOperation({ summary: 'Read an mcp.json', description: "Returns the text of the user's `mcp.json`, or the project's with `thread`, and its modified time (the editor sends it back with a save)." })
  @Responds(McpFileSchema)
  @Fails({ 400: 'The project’s file needs a thread.' })
  file(@Query({ schema: McpFileScopeQuerySchema }) query: McpFileScopeQuery): Promise<McpFile> {
    return this.edit.readFile(query.thread || undefined, query.scope);
  }

  @Put('mcp/file')
  @ApiOperation({ summary: 'Save an mcp.json', description: 'Saves the text when it is valid for pi and the file has not changed since `mtime`, then reloads the thread’s session so the servers connect again.' })
  @Responds(McpFileSavedSchema)
  @Fails({ 400: 'The text is not a valid mcp.json; the message names the line.', 409: 'The file changed since it was opened.' })
  saveFile(@Query({ schema: McpFileScopeQuerySchema }) query: McpFileScopeQuery, @Body({ schema: McpFilePutSchema }) body: McpFilePut): Promise<McpFileSaved> {
    return this.edit.writeFile(query.thread || undefined, query.scope, body);
  }

  @Post('mcp/servers')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Add an MCP server',
    description:
      "Writes a server of your own into the user's `mcp.json`, or the project's with `scope: project` and a `thread` in a trusted folder. A header or environment value that looks like a secret goes to the credential store and the file gets the command that prints it. With `thread` the session reloads, and a URL server without a token starts its sign-in.",
  })
  @Responds(McpActionResultSchema)
  @Fails({ 400: 'A project entry cannot hold a secret.', 409: 'The name is taken, the folder is not trusted, or a run holds the thread.' })
  create(@Query({ schema: OptionalThreadQuerySchema }) query: z.infer<typeof OptionalThreadQuerySchema>, @Body({ schema: McpServerCreateSchema }) body: McpServerCreate): Promise<McpActionResult> {
    return this.edit.create(query.thread || undefined, body);
  }

  @Get('mcp/servers/:name')
  @ApiOperation({ summary: 'Get a server for the edit form', description: 'Returns an MCP server as the details form shows it, read from the file that defines it. A stored secret has no value, only `stored`.' })
  @ApiParam(SERVER_NAME)
  @Responds(McpServerDetailSchema)
  @Fails({ 404: NO_SERVER })
  detail(@Param('name') name: string, @Query({ schema: McpServerQuerySchema }) query: McpServerQuery): Promise<McpServerDetail> {
    return this.edit.detail(query.thread || undefined, name, query.scope);
  }

  @Patch('mcp/servers/:name')
  @ApiOperation({ summary: 'Change an MCP server', description: 'Saves the details form over the entry in the file of `scope`; a different `name` moves the entry. A row without a value keeps what the file has, and keys the form does not know stay.' })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 400: 'A project entry cannot hold a secret.', 404: NO_SERVER, 409: 'The new name is taken, or a run holds the thread.' })
  change(
    @Param('name') name: string,
    @Query({ schema: McpServerQuerySchema }) query: McpServerQuery,
    @Body({ schema: McpServerBodySchema }) body: McpServerBody,
  ): Promise<McpActionResult> {
    return this.edit.update(query.thread || undefined, name, query.scope ?? 'user', body);
  }

  @Delete('mcp/servers/:name')
  @ApiOperation({ summary: 'Remove an MCP server', description: "Takes the server out of the file that defines it, signs out of an OAuth server, forgets the secrets pi-kit stored for it, and reloads the thread's session." })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 404: NO_SERVER, 409: 'An OAuth server needs a thread to sign out in, or a run holds the thread.' })
  remove(@Param('name') name: string, @Query({ schema: OptionalThreadQuerySchema }) query: z.infer<typeof OptionalThreadQuerySchema>): Promise<McpActionResult> {
    return this.connectors.disconnect(query.thread || undefined, name);
  }

  @Post('mcp/reload')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reload the MCP servers', description: "Reloads the thread's session so it reads the MCP configuration again, and answers with the servers." })
  @Responds(McpActionResultSchema)
  @Fails({ 404: 'There is no such thread.', 409: NOT_IDLE })
  reload(@Query({ schema: ThreadQuerySchema }) query: z.infer<typeof ThreadQuerySchema>): Promise<McpActionResult> {
    return this.mcp.reload(query.thread);
  }

  @Post('mcp/servers/:name/enabled')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enable or disable a server', description: 'Switches an MCP server on or off in pi\'s configuration, and answers with the servers.' })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 404: NO_SERVER, 409: NOT_IDLE })
  enabled(
    @Param('name') name: string,
    @Query({ schema: ThreadQuerySchema }) query: z.infer<typeof ThreadQuerySchema>,
    @Body({ schema: McpEnabledRequestSchema }) body: z.infer<typeof McpEnabledRequestSchema>,
  ): Promise<McpActionResult> {
    return this.mcp.setEnabled(query.thread, name, body.enabled);
  }

  @Post('mcp/servers/:name/reconnect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reconnect a server', description: "Asks the thread's session to connect to the server again, and answers with the servers." })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 404: NO_SERVER, 409: NOT_IDLE })
  reconnect(@Param('name') name: string, @Query({ schema: ThreadQuerySchema }) query: z.infer<typeof ThreadQuerySchema>): Promise<McpActionResult> {
    return this.mcp.reconnect(query.thread, name);
  }

  @Post('mcp/servers/:name/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in to a server', description: "Starts the OAuth sign-in of an HTTP server in the thread's session. The answer carries the link to open when the browser did not open." })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 404: NO_SERVER, 409: NOT_IDLE })
  login(@Param('name') name: string, @Query({ schema: ThreadQuerySchema }) query: z.infer<typeof ThreadQuerySchema>): Promise<McpActionResult> {
    return this.mcp.login(query.thread, name);
  }

  /** The person gave up on a sign-in that waits for the browser. */
  @Post('mcp/servers/:name/signin/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a sign-in', description: 'Gives up a sign-in that waits for the browser, and answers with the servers.' })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 404: NO_SERVER })
  cancelSignIn(@Param('name') name: string, @Query({ schema: ThreadQuerySchema }) query: z.infer<typeof ThreadQuerySchema>): Promise<McpActionResult> {
    return this.mcp.cancelSignIn(query.thread, name);
  }

  /** The redirect URL copied from a browser on another machine finishes the sign-in (what pi's own prompt asks for). */
  @Post('mcp/servers/:name/signin/paste')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finish a sign-in with a redirect URL', description: 'Finishes a sign-in with the redirect URL copied from a browser on another machine, what pi\'s own prompt asks for.' })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 404: NO_SERVER, 409: 'No sign-in to that server is waiting for a redirect URL.' })
  pasteSignIn(
    @Param('name') name: string,
    @Query({ schema: ThreadQuerySchema }) query: z.infer<typeof ThreadQuerySchema>,
    @Body({ schema: SignInPasteRequestSchema }) body: z.infer<typeof SignInPasteRequestSchema>,
  ): Promise<McpActionResult> {
    return this.mcp.pasteSignIn(query.thread, name, body.url);
  }

  @Post('mcp/servers/:name/logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign out of a server', description: "Forgets the sign-in of an HTTP server in the thread's session, and answers with the servers." })
  @ApiParam(SERVER_NAME)
  @Responds(McpActionResultSchema)
  @Fails({ 404: NO_SERVER, 409: NOT_IDLE })
  logout(@Param('name') name: string, @Query({ schema: ThreadQuerySchema }) query: z.infer<typeof ThreadQuerySchema>): Promise<McpActionResult> {
    return this.mcp.logout(query.thread, name);
  }
}

/**
 * The sandbox proxy document for MCP Apps. It has to be reachable by an `<iframe src>`, which cannot send the
 * bearer token, and it holds no secret and does nothing but relay messages (see `mcp-sandbox.ts`), so this is one
 * of the few routes without the token.
 */
@ApiTags('mcp')
@Controller('mcp-sandbox')
export class McpSandboxController {
  @Public()
  @Get('proxy.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', SANDBOX_PROXY_CSP)
  @ApiOperation({ summary: 'Get the MCP App sandbox proxy', description: 'Returns the page an MCP App iframe loads to relay messages to the app. It needs no token, because an iframe cannot send one, and it holds no secret.' })
  @ApiProduces('text/html')
  @ApiOkResponse({ description: 'The proxy document.', content: { 'text/html': { schema: { type: 'string' } } } })
  proxy(): string {
    return SANDBOX_PROXY_HTML;
  }
}
