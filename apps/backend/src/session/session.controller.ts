import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BashRequestSchema,
  ChangelogSchema,
  type Changelog,
  type Command,
  CommandSchema,
  CompactRequestSchema,
  type CompactResult,
  CompactResultSchema,
  ExportRequestSchema,
  type ExportResult,
  ExportResultSchema,
  type FileMatch,
  FileMatchSchema,
  type FileNode,
  FileNodeSchema,
  FileTreeQuerySchema,
  FilesQuerySchema,
  flagOn,
  FsCreateSchema,
  FsDeleteSchema,
  FsEntryPathSchema,
  FsRenameSchema,
  type ModelList,
  ModelListQuerySchema,
  ModelListSchema,
  OpenPathRequestSchema,
  type OpenPathResult,
  OpenPathResultSchema,
  PatchModelSchema,
  type PiActivityContent,
  PiBashContentSchema,
  type ReloadResult,
  ReloadResultSchema,
  type SessionContext,
  type SessionStats,
  SessionStatsSchema,
  SessionContextSchema,
  type ThreadUsage,
  ThreadUsageSchema,
  type WatchEvent,
  WatchEventSchema,
} from '@pi-kit/protocol';
import type { Response } from 'express';
import type { z } from 'zod';
import { Fails, Responds, Streams, ThreadIdParam, WorkspaceIdParam } from '../contract';
import { MetaRepository } from '../db/meta.repository';
import { RedactionService } from '../db/redaction.service';
import { ThreadsRepository } from '../db/threads.repository';
import { DesktopBridge } from '../desktop/desktop-bridge';
import { loadPi, PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';
import { CommandsService } from './commands.service';
import { FolderChangesService } from '../folder-changes/folder-changes.service';
import { insideWorkspace } from './safe-path';
import { FilesService } from './files.service';
import { readThreadUsage } from './usage';
import { FsService } from './fs.service';

const WATCH_PING_MS = 20_000;
const BASH_STREAM_INTERVAL_MS = 100;
/** The part of a long command's output kept in memory and streamed; pi keeps the full output in a file. */
const BASH_TAIL_CHARS = 256 * 1024;

const NO_THREAD = 'There is no such thread.';
const NOT_IDLE = 'A run holds the thread: stop it first.';

/**
 * The REST face of the "action" commands and what the composer needs next to the AG-UI stream:
 * the command list, model and thinking level, compaction, reload, export, session stats, `!shell` commands
 * and `@file` search. Everything that is conversation stays in AG-UI.
 */
@Controller()
export class SessionController {
  constructor(
    private readonly threads: ThreadsService,
    private readonly sessions: PiSessionService,
    private readonly commands: CommandsService,
    private readonly files: FilesService,
    private readonly meta: MetaRepository,
    private readonly desktop: DesktopBridge,
    private readonly fs: FsService,
    private readonly folderChanges: FolderChangesService,
    private readonly redaction: RedactionService,
    private readonly threadRows: ThreadsRepository,
  ) {}

  @ApiTags('session')
  @ThreadIdParam()
  @Get('threads/:id/commands')
  @ApiOperation({
    summary: 'List commands',
    description:
      'Lists the slash commands of the thread: skills, prompt templates, extension commands and the actions the app handles itself.',
  })
  @Responds(CommandSchema, { array: true })
  @Fails({ 404: NO_THREAD })
  listCommands(@Param('id') id: string): Promise<Command[]> {
    return this.commands.list(id);
  }

  @ApiTags('session')
  @ThreadIdParam()
  @Get('threads/:id/stats')
  @ApiOperation({
    summary: "Get a thread's session stats",
    description: "Returns the session's message counts, tokens, cost, context use, model and thinking level.",
  })
  @Responds(SessionStatsSchema)
  @Fails({ 404: NO_THREAD })
  async stats(@Param('id') id: string): Promise<SessionStats> {
    await this.threads.openSession(id);
    return this.sessions.stats(id);
  }

  @ApiTags('session')
  @ThreadIdParam()
  @Get('threads/:id/context')
  @ApiOperation({
    summary: "Get a thread's context, piece by piece",
    description:
      'What pi keeps for the model right now: the system prompt by section, the tool definitions, the compaction summaries, the skill blocks, every message part and tool result, each with where it came from and its estimated tokens (characters over four, as pi counts). For reading why a context is full.',
  })
  @Responds(SessionContextSchema)
  @Fails({ 404: NO_THREAD })
  async context(@Param('id') id: string): Promise<SessionContext> {
    await this.threads.openSession(id);
    return this.sessions.context(id);
  }

  /** Usage by model and by turn, aggregated from the session file (not the open session, not the event log): CLI turns count. */
  @ApiTags('session')
  @ThreadIdParam()
  @Get('threads/:id/usage')
  @ApiOperation({
    summary: "Get a thread's usage",
    description:
      'Returns tokens and cost by model and by turn, read from the session file, so turns run from the pi command line count too.',
  })
  @Responds(ThreadUsageSchema)
  @Fails({ 404: NO_THREAD })
  async usage(@Param('id') id: string): Promise<ThreadUsage> {
    return readThreadUsage(this.threads.sessionPathOf(id), id);
  }

  @ApiTags('session')
  @Get('models')
  @ApiOperation({
    summary: 'List models',
    description:
      "Lists the models the thread's session can use, the current one, the thinking level and the cycling scope.",
  })
  @Responds(ModelListSchema)
  @Fails({ 404: NO_THREAD })
  async models(
    @Query({ schema: ModelListQuerySchema }) query: z.infer<typeof ModelListQuerySchema>,
  ): Promise<ModelList> {
    await this.threads.openSession(query.thread);
    return this.sessions.models(query.thread);
  }

  @ApiTags('session')
  @ThreadIdParam()
  @Patch('threads/:id/model')
  @ApiOperation({
    summary: 'Change the model',
    description:
      'Switches the thread to another model or thinking level, or cycles to the next one, and answers with the session stats.',
  })
  @Responds(SessionStatsSchema)
  @Fails({ 400: 'pi does not accept that model or level.', 404: NO_THREAD })
  async setModel(
    @Param('id') id: string,
    @Body({ schema: PatchModelSchema }) change: z.infer<typeof PatchModelSchema>,
  ): Promise<SessionStats> {
    await this.threads.openSession(id);
    try {
      await this.sessions.setModel(id, change);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    return this.sessions.stats(id);
  }

  @ApiTags('session')
  @ThreadIdParam()
  @Post('threads/:id/compact')
  @ApiOperation({
    summary: 'Compact the context',
    description: 'Summarizes the thread so far to free context, optionally with instructions for the summary.',
  })
  @Responds(CompactResultSchema, { status: 201 })
  @Fails({ 404: NO_THREAD, 409: 'A run holds the thread, or compaction failed.' })
  async compact(
    @Param('id') id: string,
    @Body({ schema: CompactRequestSchema }) body: z.infer<typeof CompactRequestSchema>,
  ): Promise<CompactResult> {
    await this.threads.openSession(id);
    this.requireIdle(id, 'compact');
    try {
      return await this.sessions.compact(id, body.instructions);
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
  }

  @ApiTags('session')
  @ThreadIdParam()
  @Post('threads/:id/reload')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reload the session',
    description:
      'Reloads extensions, skills, prompt templates and settings of the thread, and answers with how many commands it has now.',
  })
  @Responds(ReloadResultSchema)
  @Fails({ 404: NO_THREAD, 409: NOT_IDLE })
  async reload(@Param('id') id: string): Promise<ReloadResult> {
    await this.threads.openSession(id);
    this.requireIdle(id, 'reload');
    await this.sessions.reload(id);
    return { commands: (await this.commands.list(id)).length };
  }

  @ApiTags('session')
  @ThreadIdParam()
  @Post('threads/:id/export')
  @ApiOperation({
    summary: 'Export a thread',
    description:
      'Writes the thread to an HTML or JSONL file, with key-shaped text masked first, and answers with the path.',
  })
  @Responds(ExportResultSchema, { status: 201 })
  @Fails({ 404: NO_THREAD })
  async export(
    @Param('id') id: string,
    @Body({ schema: ExportRequestSchema }) body: z.infer<typeof ExportRequestSchema>,
  ): Promise<ExportResult> {
    await this.threads.openSession(id);
    const result = await this.sessions.exportSession(id, body.path);
    // Everything that leaves through pi-kit runs the redaction pass first: the file pi wrote is rewritten with key shapes masked, unless the folder has the pass switched off.
    const cwd = this.threadRows.get(id)?.cwd;
    const written = readFileSync(result.path, 'utf8');
    const redacted = result.format === 'jsonl' ? this.redaction.jsonl(cwd, written) : this.redaction.html(cwd, written);
    if (redacted.count > 0) writeFileSync(result.path, redacted.text);
    return { ...result, redacted: redacted.count };
  }

  /**
   * `!command`: runs it through pi and streams NDJSON, one `pi.bash` activity content per line (throttled,
   * the last with `running: false`). The renderer shows it as a bash activity; `abort-bash` stops it.
   */
  @ApiTags('session')
  @ThreadIdParam()
  @Post('threads/:id/bash')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run a shell command',
    description:
      'Runs a `!command` through pi and streams newline-delimited JSON: one `PiBashContent` per line, throttled, the last with `running: false`. Closing the connection stops the command.',
  })
  @Streams(PiBashContentSchema, 'The output so far, until the command ends.')
  @Fails({ 404: NO_THREAD, 409: 'A shell command is already running in this thread.' })
  async bash(
    @Param('id') id: string,
    @Body({ schema: BashRequestSchema }) body: z.infer<typeof BashRequestSchema>,
    @Res() res: Response,
  ): Promise<void> {
    const { command, excludeFromContext } = body;
    await this.threads.openSession(id);
    if (this.sessions.isBashRunning(id))
      throw new ConflictException('A shell command is already running in this thread.');

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (content: PiActivityContent<'pi.bash'>): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(content)}\n`);
    };
    // A client that goes away takes its command with it.
    res.on('close', () => {
      if (!res.writableEnded) this.sessions.abortBash(id);
    });

    let output = '';
    let lastSent = 0;
    send({ command, output, running: true, user: true });
    try {
      const result = await this.sessions.executeBash(
        id,
        command,
        (chunk) => {
          output = (output + chunk).slice(-BASH_TAIL_CHARS);
          if (Date.now() - lastSent >= BASH_STREAM_INTERVAL_MS) {
            lastSent = Date.now();
            send({ command, output, running: true, user: true });
          }
        },
        excludeFromContext,
      );
      send({
        command,
        output: result.output,
        running: false,
        user: true,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.cancelled ? { cancelled: true } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      });
    } catch (error) {
      send({
        command,
        output: `${output}\n${error instanceof Error ? error.message : String(error)}`,
        running: false,
        user: true,
        exitCode: 1,
      });
    }
    res.end();
  }

  @ApiTags('session')
  @ThreadIdParam()
  @Post('threads/:id/abort-bash')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Stop a shell command',
    description: 'Stops the `!command` that runs in the thread, if one does.',
  })
  @ApiNoContentResponse({ description: 'The command is stopped, or none was running.' })
  abortBash(@Param('id') id: string): void {
    this.sessions.abortBash(id);
  }

  /** `@file` completion. `:id` is the workspace's folder, URL-encoded (a workspace has no other id). */
  @ApiTags('files')
  @WorkspaceIdParam()
  @Get('workspaces/:id/files')
  @ApiOperation({
    summary: 'Find files',
    description: 'Finds files of the project by fuzzy match on the path, for `@file` completion.',
  })
  @Responds(FileMatchSchema, { array: true })
  @Fails({ 404: 'The folder is not a known project.' })
  async workspaceFiles(
    @Param('id') id: string,
    @Query({ schema: FilesQuerySchema }) query: z.infer<typeof FilesQuerySchema>,
  ): Promise<FileMatch[]> {
    return this.files.search(this.workspace(id), query.q ?? '', query.limit ?? 50);
  }

  /** The Files panel: the entries under `dir` (default: the root), ignore-aware, folders first; `ignored=1` lists what git ignores too. */
  @ApiTags('files')
  @WorkspaceIdParam()
  @Get('workspaces/:id/tree')
  @ApiOperation({
    summary: 'List a folder',
    description:
      'Lists the entries under `dir` (the root without it), ignore-aware and folders first. `ignored=1` lists what git ignores too.',
  })
  @Responds(FileNodeSchema, { array: true })
  @Fails({ 400: 'The path leads outside the folder.', 404: 'The folder is not a known project.' })
  async workspaceTree(
    @Param('id') id: string,
    @Query({ schema: FileTreeQuerySchema }) query: z.infer<typeof FileTreeQuerySchema>,
  ): Promise<FileNode[]> {
    const cwd = this.workspace(id);
    const dir = query.dir ?? '';
    if (dir) insideWorkspace(cwd, dir);
    return this.files.children(cwd, dir, { showIgnored: flagOn(query.ignored) });
  }

  /**
   * The live refresh: newline-delimited JSON, `ready` at once, then a `change` whenever the backend learns that the folder changed (a run ended,
   * `HEAD` moved), and a `ping` every 20 s. Nothing watches or polls the folder for it.
   */
  @ApiTags('files')
  @WorkspaceIdParam()
  @Get('workspaces/:id/watch')
  @ApiOperation({
    summary: 'Watch a folder',
    description:
      'Keeps the connection open and sends newline-delimited JSON: `ready` at once, a `change` with the changed paths when a run in the folder ends or its git HEAD moves, and a `ping` every 20 seconds.',
  })
  @Streams(WatchEventSchema, 'The stream stays open until the client closes it.')
  @Fails({ 404: 'The folder is not a known project.' })
  watchWorkspace(@Param('id') id: string, @Res() res: Response): void {
    const cwd = this.workspace(id);
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (event: WatchEvent): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    const leave = this.folderChanges.subscribe(cwd, (batch) =>
      send({ type: 'change', paths: batch.paths, overflow: batch.overflow, headMoved: batch.headMoved, at: batch.at }),
    );
    const ping = setInterval(() => send({ type: 'ping' }), WATCH_PING_MS);
    res.on('close', () => {
      clearInterval(ping);
      leave();
    });
    send({ type: 'ready' });
  }

  @ApiTags('files')
  @WorkspaceIdParam()
  @Post('workspaces/:id/reveal')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Show in the file manager',
    description: 'Asks the desktop app to show a file or folder of the project in the system file manager.',
  })
  @Responds(OpenPathResultSchema)
  @Fails({
    400: 'The path is outside the folder.',
    404: 'The folder is not a known project, or the path does not exist.',
  })
  async revealInFileManager(
    @Param('id') id: string,
    @Body({ schema: OpenPathRequestSchema }) body: z.infer<typeof OpenPathRequestSchema>,
  ): Promise<OpenPathResult> {
    const cwd = this.workspace(id);
    const absolute = insideWorkspace(cwd, body.path);
    if (!existsSync(absolute)) throw new NotFoundException(`${body.path} does not exist.`);
    return this.desktop.revealPath(absolute);
  }

  /** New file or folder, rename and delete of the Files panel's context menu. */
  @ApiTags('files')
  @WorkspaceIdParam()
  @Post('workspaces/:id/fs/create')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create a file or folder',
    description: 'Creates an empty file, or a folder with `dir`, inside the project, and answers with its path.',
  })
  @Responds(FsEntryPathSchema)
  @Fails({
    400: 'The path is outside the folder or names `.git`.',
    404: 'The folder is not a known project.',
    409: 'The entry exists already or could not be created.',
  })
  createEntry(
    @Param('id') id: string,
    @Body({ schema: FsCreateSchema }) body: z.infer<typeof FsCreateSchema>,
  ): { path: string } {
    return this.fs.create(this.workspace(id), body.path, body.dir);
  }

  @ApiTags('files')
  @WorkspaceIdParam()
  @Post('workspaces/:id/fs/rename')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rename a file or folder',
    description: 'Moves a file or folder of the project to a new path, and answers with the new path.',
  })
  @Responds(FsEntryPathSchema)
  @Fails({
    400: 'A path is outside the folder or names `.git`.',
    404: 'The folder is not a known project, or the source does not exist.',
    409: 'The target exists already or the rename failed.',
  })
  renameEntry(
    @Param('id') id: string,
    @Body({ schema: FsRenameSchema }) body: z.infer<typeof FsRenameSchema>,
  ): { path: string } {
    return this.fs.rename(this.workspace(id), body.from, body.to);
  }

  @ApiTags('files')
  @WorkspaceIdParam()
  @Post('workspaces/:id/fs/delete')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a file or folder',
    description: 'Removes a file or folder of the project from the disk. The body must say `confirm: true`.',
  })
  @ApiNoContentResponse({ description: 'The entry is deleted.' })
  @Fails({
    400: 'The path is outside the folder or names `.git`.',
    404: 'The folder is not a known project, or the path does not exist.',
  })
  deleteEntry(@Param('id') id: string, @Body({ schema: FsDeleteSchema }) body: z.infer<typeof FsDeleteSchema>): void {
    this.fs.delete(this.workspace(id), body.path);
  }

  /** "Open in editor": the desktop app opens the file with the system's default application (`shell.openPath`). */
  @ApiTags('files')
  @WorkspaceIdParam()
  @Post('workspaces/:id/open')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Open in the editor',
    description: "Asks the desktop app to open a file of the project with the system's default application.",
  })
  @Responds(OpenPathResultSchema)
  @Fails({
    400: 'The path is outside the folder.',
    404: 'The folder is not a known project, or the path does not exist.',
  })
  async openInEditor(
    @Param('id') id: string,
    @Body({ schema: OpenPathRequestSchema }) body: z.infer<typeof OpenPathRequestSchema>,
  ): Promise<OpenPathResult> {
    const cwd = this.workspace(id);
    const absolute = insideWorkspace(cwd, body.path);
    if (!existsSync(absolute)) throw new NotFoundException(`${body.path} does not exist.`);
    return this.desktop.openPath(absolute);
  }

  /** pi's own changelog, for `/changelog`. */
  @ApiTags('session')
  @Get('changelog')
  @ApiOperation({
    summary: "Get pi's changelog",
    description: "Returns pi's own changelog and its version, for the `/changelog` command.",
  })
  @Responds(ChangelogSchema)
  async changelog(): Promise<Changelog> {
    const pi = await loadPi();
    const file = join(pi.getPackageDir(), 'CHANGELOG.md');
    return {
      version: pi.VERSION,
      text: existsSync(file) ? readFileSync(file, 'utf8') : 'No changelog is shipped with this version of pi.',
    };
  }

  private workspace(id: string): string {
    return this.meta.requireWorkspace(id);
  }

  private requireIdle(id: string, what: string): void {
    if (this.sessions.stats(id).streaming) throw new ConflictException(`Stop the run before you ${what}.`);
  }
}
