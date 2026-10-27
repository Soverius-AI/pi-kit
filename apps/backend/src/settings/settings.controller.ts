import { existsSync, statSync } from 'node:fs';
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  type About,
  AboutSchema,
  CwdQuerySchema,
  type Diagnostics,
  flagOn,
  DiagnosticsSchema,
  ImportSessionSchema,
  type KeyValidation,
  KeyValidationSchema,
  type KeybindingInfo,
  KeybindingInfoSchema,
  LoginAnswerSchema,
  LoginEventSchema,
  LoginStartedSchema,
  LoginStartSchema,
  LogoutSchema,
  PatchPiSettingsSchema,
  type PiSettings,
  PiSettingsSchema,
  type PiUpdateCheck,
  PiUpdateCheckSchema,
  type ResourcesOverview,
  ResourcesOverviewSchema,
  RevokeTrustResultSchema,
  RevokeTrustSchema,
  SavePiKeybindingsSchema,
  type SettingsOverview,
  SettingsOverviewSchema,
  ThreadDetailSchema,
  type ThreadDetail,
  ToggleResourceSchema,
  TrustDecisionResultSchema,
  TrustDecisionSchema,
  type TrustList,
  TrustListSchema,
  type TrustState,
  TrustStateSchema,
  ValidateKeySchema,
  type LoginStarted,
  type RevokeTrustResult,
  type TrustDecisionResult,
  PiUpdateQuerySchema,
} from '@pi-kit/protocol';
import type { Response } from 'express';
import type { z } from 'zod';
import { Fails, Responds, Streams, WorkspaceIdParam } from '../contract';
import { MetaRepository } from '../db/meta.repository';
import { PiConfigService } from '../pi/pi-config.service';
import { PiSessionService } from '../pi/pi-session.service';
import { PiUpdateService } from '../pi/pi-update.service';
import { ResourcesService } from '../pi/resources.service';
import { TrustService } from '../pi/trust.service';
import { ThreadsService } from '../threads/threads.service';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { DiagnosticsService } from './diagnostics.service';

const LOGIN_ID = { name: 'id', description: 'The id `POST /api/auth/login` answered with.', schema: { type: 'string' } } as const;

/**
 * Settings, provider sign-in, project trust and session import. Everything here is pi's own
 * state: `settings.json`, `auth.json` and `trust.json` in the agent directory, written by pi's classes. The UI's own
 * preferences (theme, the remembered thread) stay in `PUT /api/settings/:key`.
 */
@Controller()
export class SettingsController {
  constructor(
    private readonly config: PiConfigService,
    private readonly trust: TrustService,
    private readonly sessions: PiSessionService,
    private readonly threads: ThreadsService,
    private readonly meta: MetaRepository,
    private readonly updates: PiUpdateService,
    private readonly resources: ResourcesService,
    private readonly diagnostics: DiagnosticsService,
    @Inject(CONFIG) private readonly backend: BackendConfig,
  ) {}

  @ApiTags('pi-settings')
  @Get('pi-settings')
  @ApiOperation({
    summary: "Get pi's settings",
    description: "Returns pi's settings, the providers with the state of their credentials, the models, the keybindings and pi's version, read for `cwd` (the default folder without it).",
  })
  @Responds(SettingsOverviewSchema)
  async overview(@Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>): Promise<SettingsOverview> {
    const cwd = query.cwd;
    const overview = await this.config.overview(cwd && existsSync(cwd) ? cwd : this.backend.defaultCwd);
    // When pi-kit stored a credential (pi's auth.json has no date of its own); a credential added in the CLI has none.
    const dates = this.credentialDates();
    return { ...overview, providers: overview.providers.map((p) => (p.credential && dates[p.id] ? { ...p, credential: { ...p.credential, addedAt: dates[p.id] } } : p)) };
  }

  @ApiTags('pi-settings')
  @Patch('pi-settings')
  @ApiOperation({ summary: "Change pi's settings", description: "Changes pi's default model, thinking level, compaction, trust and queue settings in its settings file, and answers with the settings." })
  @Responds(PiSettingsSchema)
  @Fails({ 400: 'pi does not accept the change.' })
  async patch(@Body({ schema: PatchPiSettingsSchema }) patch: z.infer<typeof PatchPiSettingsSchema>, @Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>): Promise<PiSettings> {
    const cwd = query.cwd;
    try {
      return await this.config.patch(cwd && existsSync(cwd) ? cwd : this.backend.defaultCwd, patch);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  // ---- about and the pi update check

  @ApiTags('pi-settings')
  @Get('about')
  @ApiOperation({ summary: 'Get the app and pi versions', description: 'Returns the version of the app, of the pi it runs sessions with, where that pi came from and the SDK range the app supports.' })
  @Responds(AboutSchema)
  about(): Promise<About> {
    return this.updates.about();
  }

  /** Asks pi's release endpoint whether a newer pi exists; `?force=1` skips the 10 minute cache. It never installs. */
  @ApiTags('pi-settings')
  @Get('about/pi-update')
  @ApiOperation({ summary: 'Check for a newer pi', description: "Asks pi's release endpoint whether a newer pi exists. `force=1` skips the ten minute cache. It never installs anything." })
  @Responds(PiUpdateCheckSchema)
  piUpdate(@Query({ schema: PiUpdateQuerySchema }) query: z.infer<typeof PiUpdateQuerySchema>): Promise<PiUpdateCheck> {
    return this.updates.check(flagOn(query.force));
  }

  // ---- provider sign-in

  @ApiTags('auth')
  @Post('auth/login')
  @ApiOperation({ summary: 'Start a provider sign-in', description: 'Starts an API-key or OAuth sign-in for a provider and answers with the id of the flow. Its events are streamed from `auth/login/{id}/events`.' })
  @Responds(LoginStartedSchema, { status: 201 })
  @Fails({ 400: 'The provider does not offer that sign-in.' })
  async startLogin(@Body({ schema: LoginStartSchema }) body: z.infer<typeof LoginStartSchema>): Promise<LoginStarted> {
    const { provider, type } = body;
    try {
      return { id: (await this.config.startLogin(provider, type, () => this.recordSignIn(provider))).id };
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  /** The flow as newline-delimited JSON (`LoginEvent`): everything so far, then each new event, ending with `done` or `error`. */
  @ApiTags('auth')
  @ApiParam(LOGIN_ID)
  @Get('auth/login/:id/events')
  @ApiOperation({ summary: 'Stream a provider sign-in', description: 'Sends the sign-in as newline-delimited JSON: everything so far, then each new event, ending with `done` or `error`.' })
  @Streams(LoginEventSchema, 'The stream ends with `done` or `error`.')
  @Fails({ 404: 'That sign-in is over or never started.' })
  events(@Param('id') id: string, @Res() res: Response): void {
    const run = this.config.login(id);
    if (!run) throw new NotFoundException('That sign-in is over or never started.');
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    let sent = 0;
    const flush = (): void => {
      while (sent < run.events.length) {
        const event = run.events[sent++];
        if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
        if (event.type === 'done' || event.type === 'error') {
          off();
          res.end();
          return;
        }
      }
    };
    const off = run.onChange(flush);
    res.on('close', off);
    flush();
  }

  @ApiTags('auth')
  @ApiParam(LOGIN_ID)
  @Post('auth/login/:id/answer')
  @HttpCode(204)
  @ApiOperation({ summary: 'Answer a sign-in question', description: 'Answers a prompt of the sign-in: an API key, a code, a choice. The value of a secret prompt is never logged.' })
  @ApiNoContentResponse({ description: 'The answer is delivered.' })
  @Fails({ 409: 'That question is no longer waiting for an answer.' })
  answer(@Param('id') id: string, @Body({ schema: LoginAnswerSchema }) body: z.infer<typeof LoginAnswerSchema>): void {
    const { promptId, value } = body;
    const run = this.config.login(id);
    if (!run?.answer(promptId, value)) throw new ConflictException('That question is no longer waiting for an answer.');
  }

  @ApiTags('auth')
  @ApiParam(LOGIN_ID)
  @Post('auth/login/:id/cancel')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel a sign-in', description: 'Gives up the sign-in. A sign-in that is over already is not an error.' })
  @ApiNoContentResponse({ description: 'The sign-in is cancelled.' })
  cancel(@Param('id') id: string): void {
    this.config.login(id)?.cancel();
  }

  @ApiTags('auth')
  @Post('auth/logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out of a provider', description: "Removes the provider's stored credential. Environment variables are not touched." })
  @ApiNoContentResponse({ description: 'The credential is removed.' })
  @Fails({ 400: 'pi could not remove the credential.' })
  async logout(@Body({ schema: LogoutSchema }) body: z.infer<typeof LogoutSchema>): Promise<void> {
    const { provider } = body;
    try {
      await this.config.logout(provider);
      this.forgetSignIn(provider);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @ApiTags('pi-settings')
  @Post('providers/remove')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a provider connection', description: 'Removes its models.json entry and stored credential. Preserves unrelated providers, environment variables, downloaded model files and chat history.' })
  @ApiNoContentResponse({ description: 'The saved connection is removed.' })
  @Fails({ 400: 'The provider connection could not be removed.' })
  async removeProvider(@Body({ schema: LogoutSchema }) body: z.infer<typeof LogoutSchema>): Promise<void> {
    try {
      await this.config.removeProvider(body.provider);
      this.forgetSignIn(body.provider);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  /** The last step of the API-key workflow: one cheap request with the credential pi stored, to say whether the provider accepts it. */
  @ApiTags('auth')
  @Post('auth/validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check a stored key', description: 'Makes one cheap request with the stored credential to say whether the provider accepts it.' })
  @Responds(KeyValidationSchema)
  validate(@Body({ schema: ValidateKeySchema }) body: z.infer<typeof ValidateKeySchema>): Promise<KeyValidation> {
    return this.config.validate(body.provider);
  }

  // ---- keybindings (pi's keybindings.json)

  @ApiTags('pi-settings')
  @Get('pi-keybindings')
  @ApiOperation({ summary: "List pi's keybindings", description: 'Lists the actions of pi with the keys in effect, pi\'s default and whether the keybindings file overrides it.' })
  @Responds(KeybindingInfoSchema, { array: true })
  keybindings(): Promise<KeybindingInfo[]> {
    return this.config.keybindings();
  }

  /** Saves the customised keys of pi's actions (the whole set); every other key of the file is kept. */
  @ApiTags('pi-settings')
  @Put('pi-keybindings')
  @ApiOperation({ summary: "Save pi's keybindings", description: "Saves the customised keys of pi's actions, the whole set at once. Every other key of the file is kept. Answers with the keybindings." })
  @Responds(KeybindingInfoSchema, { array: true })
  @Fails({ 400: 'pi does not accept the keybindings.' })
  async saveKeybindings(@Body({ schema: SavePiKeybindingsSchema }) body: z.infer<typeof SavePiKeybindingsSchema>): Promise<KeybindingInfo[]> {
    try {
      return await this.config.saveKeybindings(body.overrides);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  // ---- extensions, skills and prompt templates

  @ApiTags('pi-settings')
  @Get('resources')
  @ApiOperation({ summary: 'List extensions, skills and prompts', description: "Lists pi's extensions, skills and prompt templates from the user's settings and, for a trusted folder, the project's." })
  @Responds(ResourcesOverviewSchema)
  listResources(@Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>): Promise<ResourcesOverview> {
    const cwd = query.cwd;
    return this.resources.overview(cwd && existsSync(cwd) ? cwd : this.backend.defaultCwd);
  }

  @ApiTags('pi-settings')
  @Post('resources/toggle')
  @HttpCode(200)
  @ApiOperation({ summary: 'Switch a resource on or off', description: "Enables or disables one extension, skill or prompt template in pi's settings, and answers with the list." })
  @Responds(ResourcesOverviewSchema)
  @Fails({ 400: 'pi does not know that resource.' })
  async toggleResource(@Body({ schema: ToggleResourceSchema }) body: z.infer<typeof ToggleResourceSchema>, @Query({ schema: CwdQuerySchema }) query: z.infer<typeof CwdQuerySchema>): Promise<ResourcesOverview> {
    const { key, enabled } = body;
    const cwd = query.cwd;
    try {
      return await this.resources.toggle(cwd && existsSync(cwd) ? cwd : this.backend.defaultCwd, key, enabled);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  // ---- diagnostics

  @ApiTags('pi-settings')
  @Get('diagnostics')
  @ApiOperation({ summary: 'Get diagnostics', description: 'Returns what a bug report needs: the backend process, the app and pi versions, the paths, the log files and the switches that change what the backend does. Never a secret.' })
  @Responds(DiagnosticsSchema)
  diagnose(): Promise<Diagnostics> {
    return this.diagnostics.read();
  }

  // ---- saved trust decisions

  @ApiTags('trust')
  @Get('trust')
  @ApiOperation({ summary: 'List saved trust decisions', description: "Lists the folders pi saved a trust answer for, with whether each is a known project and still exists." })
  @Responds(TrustListSchema)
  trustList(): Promise<TrustList> {
    return this.trust.list(this.meta.listWorkspaces().map((w) => w.cwd));
  }

  /** Forgets one saved answer (pi's `trust.json`); idle sessions of that folder close so they reopen under the new state. */
  @ApiTags('trust')
  @Post('trust/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Forget a trust decision', description: "Forgets one saved answer in pi's trust file. Idle sessions of that folder close, so they reopen under the new state; running ones are left alone." })
  @Responds(RevokeTrustResultSchema)
  async revokeTrust(@Body({ schema: RevokeTrustSchema }) body: z.infer<typeof RevokeTrustSchema>): Promise<RevokeTrustResult> {
    const { path } = body;
    await this.trust.revoke(path);
    const { closed, running } = this.applyTrustTo(path);
    return { ...(await this.trustList()), reopened: closed.length, running: running.length };
  }

  // ---- project trust

  @ApiTags('trust')
  @WorkspaceIdParam()
  @Get('workspaces/:id/trust')
  @ApiOperation({ summary: "Get a project's trust state", description: 'Returns whether pi trusts the project folder, where that answer came from and the project resources that trust gates.' })
  @Responds(TrustStateSchema)
  @Fails({ 404: 'The folder is not a known project.' })
  trustState(@Param('id') id: string): Promise<TrustState> {
    return this.trust.state(this.workspace(id));
  }

  @ApiTags('trust')
  @WorkspaceIdParam()
  @Post('workspaces/:id/trust')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decide whether to trust a project', description: 'Records the answer for the project folder: skip it, trust it once, always, or never. Idle sessions of the folder and its worktrees close, so they reopen under the new answer.' })
  @Responds(TrustDecisionResultSchema)
  @Fails({ 404: 'The folder is not a known project.' })
  async decide(@Param('id') id: string, @Body({ schema: TrustDecisionSchema }) body: z.infer<typeof TrustDecisionSchema>): Promise<TrustDecisionResult> {
    const cwd = this.workspace(id);
    const state = await this.trust.decide(cwd, body.decision);
    // Sessions that are open in this folder were opened under the old answer; the idle ones are closed so they reopen under the new one.
    const { closed, running } = this.applyTrustTo(cwd);
    return { ...state, reopened: closed.length, running: running.length };
  }

  /** The project's folder and the worktrees of its threads, which inherit its answer. */
  private applyTrustTo(cwd: string): { closed: string[]; running: string[] } {
    const folders = [cwd, ...this.threads.worktreeFoldersOf(cwd)];
    const results = folders.map((folder) => this.sessions.applyTrust(folder));
    return { closed: results.flatMap((r) => r.closed), running: results.flatMap((r) => r.running) };
  }

  // ---- import

  @ApiTags('threads')
  @Post('import')
  @ApiOperation({ summary: 'Import a session', description: 'Copies a pi session file into a new thread in a project folder, and answers with the thread.' })
  @Responds(ThreadDetailSchema, { status: 201 })
  @Fails({ 400: 'The file is not a pi session.' })
  async importSession(@Body({ schema: ImportSessionSchema }) body: z.infer<typeof ImportSessionSchema>): Promise<ThreadDetail> {
    const { path, cwd } = body;
    let file: string;
    try {
      file = this.config.resolveSessionFile(path);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    if (!statSync(file).isFile()) throw new BadRequestException(`${file} is not a file.`);
    return this.threads.importFrom(file, cwd);
  }

  private credentialDates(): Record<string, number> {
    const value = this.meta.getSetting('credentialDates');
    return value && typeof value === 'object' ? (value as Record<string, number>) : {};
  }

  private recordSignIn(provider: string): void {
    this.meta.setSetting('credentialDates', { ...this.credentialDates(), [provider]: Date.now() });
  }

  private forgetSignIn(provider: string): void {
    const { [provider]: _removed, ...rest } = this.credentialDates();
    this.meta.setSetting('credentialDates', rest);
  }

  private workspace(id: string): string {
    return this.meta.requireWorkspace(id);
  }
}
