import {
  Body,
  Controller,
  Delete,
  Patch,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  RequestMethod,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  ApproveRoomTaskSchema,
  CreateRoomSchema,
  RoomWorkerCandidateListSchema,
  ThreadProtectionSchema,
  PostRoomMessageSchema,
  RoomDetailSchema,
  RoomEventSchema,
  RoomEventsQuerySchema,
  RoomStreamLineSchema,
  RoomTaskSchema,
  RoomListSchema,
  ROOMS_PERSONAL_ACCEPT,
  RoomSchema,
  RoomStartPreviewSchema,
  RoomStartQuerySchema,
  RoomDirectorySchema,
  RoomTaskAnswerSchema,
  A2A_TOKEN_HEADER,
  A2A_VERSION_HEADER,
  A2A_EXTENSIONS_HEADER,
  A2aJsonSchema,
  A2aServiceParametersSchema,
  A2aAgentListSchema,
  RoomCloneListSchema,
  UpdateRoomSchema,
  ArchiveRoomSchema,
  RoomRunListSchema,
  RoomClonesQuerySchema,
  A2aAgentSchema,
  AddA2aAgentSchema,
  PlaybookListSchema,
  PlaybooksQuerySchema,
  RoomActionDecisionSchema,
  RoomActionSchema,
  PlaybookDetailSchema,
  PlaybookTrySchema,
  PlaybookTryResultSchema,
  PlaybookFireSchema,
  PlaybookFireResultSchema,
} from '@pi-kit/protocol';
import type {
  PlaybookDetail,
  PlaybookTry,
  PlaybookTryResult,
  PlaybookFire,
  PlaybookFireResult,
  ApproveRoomTask,
  CreateRoom,
  RoomWorkerCandidate,
  ThreadProtection,
  PostRoomMessage,
  Room,
  RoomDetail,
  RoomEvent,
  RoomStartPreview,
  RoomStreamLine,
  RoomTask,
  RoomDirectoryEntry,
  RoomTaskAnswer,
  A2aAgent,
  RoomClone,
  UpdateRoom,
  ArchiveRoom,
  RoomRun,
  AddA2aAgent,
  PlaybookSummary,
  RoomAction,
  RoomActionDecision,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { SSE_HEADERS, formatSSEErrorEvent, formatSSEEvent } from '@a2a-js/sdk';
import { JsonRpcTransportHandler } from '@a2a-js/sdk/server';
import { Fails, Remote, Responds, Streams } from '../contract';
import { RoomBus } from './room-bus';
import { RoomRuns } from './room-runs';
import { RoomLive } from './room-live';
import { RoomWorkspace } from './room-workspace.service';
import { RoomPlaybookService } from './room-playbook.service';
import { RoomPlaybookEditor } from './room-playbook-editor.service';
import { RoomDirectoryService } from './room-directory.service';
import { RoomEnvironments } from './room-environments';
import { LEAD_BUSY, LEAD_WAITS, NO_LEAD_QUESTION, NO_ROOM, RoomLeadService } from './room-lead.service';
import { BAD_PUSH, NOT_THE_WORKER, NO_QUESTION, NO_TASK, RoomTasksService, TASK_STATE } from './room-tasks.service';
import { RoomA2aServer } from './room-a2a.server';
import { NO_AGENT, RoomA2aAgents } from './room-a2a-agents';
import { NO_CLONE } from './room-worker.service';
import { PeerProxy } from '../peers/peer-proxy';
import { ROOMS_OFF, RoomsEnabledGuard } from './rooms-enabled.guard';
import { NOT_A_REPOSITORY, NO_THREAD, RoomsService, SEVERAL_CLONES } from './rooms.service';

@ApiTags('rooms')
@Controller('rooms')
@UseGuards(RoomsEnabledGuard)
export class RoomsController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly lead: RoomLeadService,
    private readonly tasks: RoomTasksService,
    private readonly bus: RoomBus,
    private readonly roomDirectory: RoomDirectoryService,
    private readonly environments: RoomEnvironments,
    private readonly outside: RoomA2aAgents,
    private readonly playbook: RoomPlaybookService,
    private readonly editor: RoomPlaybookEditor,
    private readonly runs: RoomRuns,
    private readonly live: RoomLive,
    private readonly workspace: RoomWorkspace,
  ) {}

  @Remote()
  @Get()
  @ApiOperation({
    summary: 'List hosted rooms',
    description:
      'Returns hosted rooms, newest first. Peer callers must advertise Accept: application/vnd.pi-kit.rooms+json; personal=1 to include personal rooms. Older peers receive repository rooms only; local owners always receive all rooms.',
  })
  @Responds(RoomListSchema)
  @Fails({ 404: ROOMS_OFF })
  async hosted(@Req() request?: Request): Promise<Room[]> {
    const rooms = await this.rooms.hosted();
    const peer = request?.headers[PeerProxy.CALLER_HEADER];
    const accept = request?.headers.accept;
    const personal = accept?.split(',').some((value) => value.trim() === ROOMS_PERSONAL_ACCEPT);
    return peer && !personal ? rooms.filter((room) => room.repository && room.baseCommit) : rooms;
  }

  @Remote()
  @Get('start')
  @ApiOperation({
    summary: 'Preview a room from a thread',
    description:
      "Reads the thread's repository on this environment: its logical name from the origin remote, the branch, the base commit and how many files are uncommitted.",
  })
  @Responds(RoomStartPreviewSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_THREAD}`, 409: NOT_A_REPOSITORY })
  start(
    @Query({ schema: RoomStartQuerySchema }) query: z.infer<typeof RoomStartQuerySchema>,
  ): Promise<RoomStartPreview> {
    return this.rooms.preview(query.threadId);
  }

  @Remote()
  @Post()
  @ApiOperation({
    summary: 'Create a room',
    description:
      "Creates a room hosted on this environment, from a thread (the repository and base commit are read from the thread's folder, which the room integrates into), from a `projectFolder` alone (a git repository here with a commit; it becomes a project of this environment), or from a repository and base commit that a project on this environment has. With several such projects, `projectFolder` names the one the room integrates into (see GET /api/rooms/clones). Only the given summary is stored as shared context.",
  })
  @Responds(RoomSchema, { status: 201 })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_THREAD}`, 409: `${NOT_A_REPOSITORY} Or: ${NO_CLONE} Or: ${SEVERAL_CLONES}` })
  async create(@Body({ schema: CreateRoomSchema }) body: CreateRoom): Promise<Room> {
    const room = await this.rooms.create(body);
    await this.lead.prepare(room.id);
    return room;
  }

  @Remote()
  @Get('directory')
  @ApiOperation({
    summary: 'List rooms across environments',
    description:
      'Returns the rooms this environment hosts and the rooms of every paired environment. A paired environment that does not answer keeps its last known rooms, marked as unreachable.',
  })
  @Responds(RoomDirectorySchema)
  @Fails({ 404: ROOMS_OFF })
  directory(): Promise<RoomDirectoryEntry[]> {
    return this.roomDirectory.list();
  }

  @Remote()
  @Get('hosts')
  @ApiOperation({
    summary: 'List environments that can host a room',
    description: 'Returns this environment and every paired environment, each with whether it can host a room now.',
  })
  @Responds(RoomWorkerCandidateListSchema)
  @Fails({ 404: ROOMS_OFF })
  hosts(): Promise<RoomWorkerCandidate[]> {
    return this.environments.list();
  }

  @Remote()
  @Get('clones')
  @ApiOperation({
    summary: 'List clones that can host a room',
    description:
      'The projects on this environment that are checkouts (not worktrees) of the repository with the base commit, clean ones first, then the most recently opened. When there are several, creating a room from the repository needs `projectFolder`.',
  })
  @Responds(RoomCloneListSchema)
  @Fails({ 404: ROOMS_OFF })
  clones(@Query({ schema: RoomClonesQuerySchema }) query: z.infer<typeof RoomClonesQuerySchema>): Promise<RoomClone[]> {
    return this.rooms.clones(query.repository, query.baseCommit);
  }

  @Remote()
  @Get('playbooks')
  @ApiOperation({
    summary: 'List room playbooks',
    description:
      'The playbooks a room can follow: skills in the project’s .pi/skills or .agents/skills folders with a room.yaml beside their SKILL.md. They are read from an open room’s project folder (`roomId`), the thread’s folder, or the first clone of the repository with the base commit. A playbook that does not parse is listed with its error.',
  })
  @Responds(PlaybookListSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_THREAD} Or: ${NO_ROOM}`, 409: NOT_A_REPOSITORY })
  playbooks(
    @Query({ schema: PlaybooksQuerySchema }) query: z.infer<typeof PlaybooksQuerySchema>,
  ): Promise<PlaybookSummary[]> {
    return query.roomId ? this.lead.roomPlaybooks(query.roomId) : this.rooms.playbooksFor(query);
  }

  @Get('agents')
  @ApiOperation({
    summary: 'List outside A2A agents',
    description:
      'The A2A agents outside pi-kit that this environment can hand room tasks to, as added in Settings. Tokens are never returned.',
  })
  @Responds(A2aAgentListSchema)
  @Fails({ 404: ROOMS_OFF })
  agents(): Promise<A2aAgent[]> {
    return this.outside.list();
  }

  @Post('agents')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Add an outside A2A agent',
    description:
      'Reads the agent card at the given address (the agent’s base address or its agent-card.json), and keeps the agent with its name. A bearer token, when given, requires the enabled operating system credential store and is never stored in application metadata.',
  })
  @Responds(A2aAgentSchema, { status: 201 })
  @Fails({ 400: 'No A2A agent card at that address, or the agent speaks no binding pi-kit supports.', 404: ROOMS_OFF })
  addAgent(@Body({ schema: AddA2aAgentSchema }) body: AddA2aAgent): Promise<A2aAgent> {
    return this.outside.add(body);
  }

  @Delete('agents/:agentId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove an outside A2A agent',
    description: 'Forgets the agent and its token. Tasks it runs keep their last known state.',
  })
  @ApiParam({ name: 'agentId', description: 'The agent id.' })
  @ApiNoContentResponse({ description: 'The agent was removed.' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_AGENT}` })
  async removeAgent(@Param('agentId') agentId: string): Promise<void> {
    await this.outside.remove(agentId);
  }

  @Remote()
  @Get(':roomId/protection')
  @ApiParam({ name: 'roomId', description: 'The hosted room id.' })
  @ApiOperation({
    summary: 'Read effective room protection',
    description:
      'Returns the room’s effective sandbox or host policy and any existing protection errors without creating a lead thread, session, or sandbox.',
  })
  @Responds(ThreadProtectionSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  protection(@Param('roomId') roomId: string): Promise<ThreadProtection> {
    return this.workspace.protectionOf(roomId);
  }

  @Remote()
  @Get(':roomId')
  @ApiOperation({
    summary: 'Get a room',
    description: 'Returns the room, its shared summary, whether its lead is answering, and its conversation so far.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @Responds(RoomDetailSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  detail(@Param('roomId') roomId: string): Promise<RoomDetail> {
    return this.lead.detail(roomId);
  }

  @Remote()
  @Patch(':roomId')
  @ApiOperation({
    summary: 'Rename a room or change how autonomous it is',
    description:
      'A title renames the room. Supervised: worker questions and results come to the owner. Assisted: the lead answers worker questions it can settle and reviews results first, sending them back for changes up to three times; the owner still approves tasks and integrates. Paused: nothing wakes the lead until the owner resumes.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @Responds(RoomDetailSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  update(@Param('roomId') roomId: string, @Body({ schema: UpdateRoomSchema }) body: UpdateRoom): Promise<RoomDetail> {
    return this.lead.update(roomId, body);
  }

  @Remote()
  @Get(':roomId/runs')
  @ApiOperation({
    summary: 'List a room’s runs',
    description:
      'Each turn of the lead is a run: what woke it (the owner, a schedule, a poll, an approval, a stage or an agent), the tools it called, the participants it consulted, the safe outputs it drafted or ran and the stages it moved to, each with its state and output. Newest first, at most fifty.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @Responds(RoomRunListSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  async listRuns(@Param('roomId') roomId: string): Promise<RoomRun[]> {
    await this.lead.found(roomId);
    return await this.runs.list(roomId);
  }

  @Remote()
  @Post(':roomId/archive')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Archive a room',
    description:
      'The room leaves every list and nothing wakes its lead again. With stopTasks its running tasks are asked to stop first; otherwise they keep running where they are. Repositories, worktrees, sessions and the room’s folder are kept.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @ApiNoContentResponse({ description: 'The room was archived.' })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  async archive(
    @Param('roomId') roomId: string,
    @Body({ schema: ArchiveRoomSchema }) body: ArchiveRoom,
  ): Promise<void> {
    await this.lead.archive(roomId);
    if (body.stopTasks) await this.tasks.stopRunning(roomId);
  }

  @Remote()
  @Post(':roomId/messages')
  @ApiOperation({
    summary: 'Post to a room',
    description:
      'Adds the owner’s message to the room. With `route: lead` the lead is prompted and its answer arrives on the room’s event stream; with `none` nobody is prompted.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @Responds(RoomEventSchema, { status: 201 })
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}`, 409: `${LEAD_BUSY} Or: ${LEAD_WAITS}` })
  post(
    @Param('roomId') roomId: string,
    @Body({ schema: PostRoomMessageSchema }) body: PostRoomMessage,
  ): Promise<RoomEvent> {
    return this.lead.post(roomId, body);
  }

  @Remote()
  @Post(':roomId/lead/answer')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Answer the lead',
    description:
      'Answers the questions the room’s lead stopped at (an approval, a choice or a text). The lead continues its turn with the answers; a cancelled answer declines that question.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @Responds(RoomDetailSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}`, 409: NO_LEAD_QUESTION })
  answerLead(
    @Param('roomId') roomId: string,
    @Body({ schema: RoomTaskAnswerSchema }) body: RoomTaskAnswer,
  ): Promise<RoomDetail> {
    return this.lead.answerQuestions(roomId, body);
  }

  @Remote()
  @Post(':roomId/actions/:actionId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Decide on a drafted action',
    description:
      'Approves or discards an action the lead drafted: a connector call the playbook does not let it run alone, a move to a stage the owner gates, or playbook files it proposes. An approved call runs on this environment and its output goes to the lead (in a rehearsal it only pretends to run); approved playbook files are written into the room’s project folder.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @ApiParam({ name: 'actionId', description: 'The action id.' })
  @Responds(RoomActionSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}`, 409: 'This action was decided already.' })
  decide(
    @Param('roomId') roomId: string,
    @Param('actionId') actionId: string,
    @Body({ schema: RoomActionDecisionSchema }) body: RoomActionDecision,
  ): Promise<RoomAction> {
    return this.playbook.decide(roomId, actionId, body);
  }

  @Remote()
  @Get(':roomId/playbook')
  @ApiOperation({
    summary: 'Show the room’s playbook',
    description:
      'The playbook the room follows: both files as they are in the room’s project folder, what they configure, when each trigger ran and runs next, how often each safe output ran in the last day, and the checks that can run before it does (MCP servers signed in, commands found, participants reachable, trigger values given).',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @Responds(PlaybookDetailSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM} Or: the room follows no playbook, or its files are gone.` })
  playbookDetail(@Param('roomId') roomId: string): Promise<PlaybookDetail> {
    return this.editor.detail(roomId);
  }

  @Remote()
  @Post(':roomId/playbook/try')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Try a playbook tool',
    description:
      'Runs one of the playbook’s tools, which only read, with the given parameters and returns its output. A safe output is never run here: the answer shows the call it would make, with its parameters filled in.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @Responds(PlaybookTryResultSchema)
  @Fails({
    400: 'A parameter is missing or not allowed.',
    404: `${ROOMS_OFF} Or: ${NO_ROOM}`,
    409: 'The room follows no playbook, or it is not valid.',
  })
  tryTool(
    @Param('roomId') roomId: string,
    @Body({ schema: PlaybookTrySchema }) body: PlaybookTry,
  ): Promise<PlaybookTryResult> {
    return this.editor.try(roomId, body);
  }

  @Remote()
  @Post(':roomId/playbook/triggers/:triggerId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Fire a playbook trigger now',
    description:
      'A schedule wakes the lead at once. A poll runs its tool and wakes the lead with what is new. With `dry`, nothing is marked seen and the lead is not woken: a poll lists which items would count as new, a schedule says what the lead would be told.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @ApiParam({ name: 'triggerId', description: 'The id of a schedule or poll of the playbook.' })
  @Responds(PlaybookFireResultSchema)
  @Fails({
    400: 'The poll’s tool failed or did not print JSON.',
    404: `${ROOMS_OFF} Or: ${NO_ROOM} Or: no such trigger.`,
    409: 'The room follows no playbook, or it is not valid.',
  })
  fireTrigger(
    @Param('roomId') roomId: string,
    @Param('triggerId') triggerId: string,
    @Body({ schema: PlaybookFireSchema }) body: PlaybookFire,
  ): Promise<PlaybookFireResult> {
    return this.playbook.fireNow(roomId, triggerId, body.dry);
  }

  @Remote()
  @Post(':roomId/tasks/:taskId/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a task',
    description:
      'Starts the proposed task on this environment or on the paired environment given: a worker in its own worktree at the room’s base commit.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @ApiParam({ name: 'taskId', description: 'The task id.' })
  @Responds(RoomTaskSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_TASK}`, 409: TASK_STATE })
  approve(
    @Param('roomId') roomId: string,
    @Param('taskId') taskId: string,
    @Body({ schema: ApproveRoomTaskSchema }) body: ApproveRoomTask,
  ): Promise<RoomTask> {
    return this.tasks.approveTask(roomId, taskId, body.environmentId);
  }

  @Remote()
  @Post(':roomId/tasks/:taskId/decline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decline a task', description: 'Declines a proposed task; nothing runs.' })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @ApiParam({ name: 'taskId', description: 'The task id.' })
  @Responds(RoomTaskSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_TASK}`, 409: TASK_STATE })
  decline(@Param('roomId') roomId: string, @Param('taskId') taskId: string): Promise<RoomTask> {
    return this.tasks.decline(roomId, taskId);
  }

  @Remote()
  @Post(':roomId/tasks/:taskId/stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop a task', description: 'Asks the running worker to stop.' })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @ApiParam({ name: 'taskId', description: 'The task id.' })
  @Responds(RoomTaskSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_TASK}`, 409: TASK_STATE })
  stop(@Param('roomId') roomId: string, @Param('taskId') taskId: string): Promise<RoomTask> {
    return this.tasks.stop(roomId, taskId);
  }

  @Remote()
  @Post(':roomId/tasks/:taskId/answer')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Answer a worker',
    description:
      'Answers the questions a running worker stopped at (an approval, a choice or a text). The worker continues with the answers.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @ApiParam({ name: 'taskId', description: 'The task id.' })
  @Responds(RoomTaskSchema)
  @Fails({
    404: `${ROOMS_OFF} Or: ${NO_TASK}`,
    409: `${TASK_STATE} Or: ${NO_QUESTION}`,
    503: 'The worker’s environment is offline.',
  })
  answer(
    @Param('roomId') roomId: string,
    @Param('taskId') taskId: string,
    @Body({ schema: RoomTaskAnswerSchema }) body: RoomTaskAnswer,
  ): Promise<RoomTask> {
    return this.tasks.answer(roomId, taskId, body);
  }

  @Remote()
  @Post(':roomId/tasks/:taskId/integrate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Integrate a task',
    description:
      'Merges the submitted task’s branch into the branch checked out in the room’s project folder. Refuses with uncommitted tracked changes there and aborts on conflicts, changing nothing.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @ApiParam({ name: 'taskId', description: 'The task id.' })
  @Responds(RoomTaskSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_TASK}`, 409: TASK_STATE })
  integrate(@Param('roomId') roomId: string, @Param('taskId') taskId: string): Promise<RoomTask> {
    return this.tasks.integrate(roomId, taskId);
  }

  @Remote()
  @Get(':roomId/workers')
  @ApiOperation({
    summary: 'List room workers',
    description: 'This environment and every paired one, with whether each can take a task of this room now.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @Responds(RoomWorkerCandidateListSchema)
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  workers(@Param('roomId') roomId: string): Promise<RoomWorkerCandidate[]> {
    return this.tasks.candidates(roomId);
  }

  @Remote()
  @Post('a2a/push')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Receive an A2A push notification',
    description:
      'The A2A push notification URL this room host gives the agents running its tasks. Takes a StreamResponse (a task or a status update) with the task’s notification token and applies it to the room task.',
  })
  @ApiNoContentResponse({ description: 'The update was applied.' })
  @Fails({ 403: `${NOT_THE_WORKER} Or: ${BAD_PUSH}`, 404: `${ROOMS_OFF} Or: ${BAD_PUSH}`, 409: TASK_STATE })
  async push(
    @Headers(PeerProxy.CALLER_HEADER) caller: string | undefined,
    @Headers(A2A_TOKEN_HEADER) token: string | undefined,
    @Body({ schema: A2aJsonSchema }) body: Record<string, unknown>,
  ): Promise<void> {
    await this.tasks.push(caller, token, body);
  }

  @Remote()
  @Get(':roomId/events')
  @ApiOperation({
    summary: 'Stream a room',
    description:
      'Keeps the connection open and sends newline-delimited JSON: the lead’s state first, then what each participant is writing right now, then every event after `after`, then each new event, lead state, run and piece of live text as it happens; blank lines keep the connection alive.',
  })
  @ApiParam({ name: 'roomId', description: 'The room id.' })
  @Streams(RoomStreamLineSchema, 'The stream stays open until the client closes it.')
  @Fails({ 404: `${ROOMS_OFF} Or: ${NO_ROOM}` })
  async events(
    @Param('roomId') roomId: string,
    @Query({ schema: RoomEventsQuerySchema }) query: z.infer<typeof RoomEventsQuerySchema>,
    @Res() res: Response,
  ): Promise<void> {
    const detail = await this.lead.detail(roomId);
    res
      .status(200)
      .set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (line: RoomStreamLine): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(line)}\n`);
    };
    const after = query.after ?? 0;
    let last = after;
    const leave = this.bus.subscribe(roomId, (line) => {
      if (line.type === 'event') {
        if (line.event.seq <= last) return;
        last = line.event.seq;
      }
      send(line);
    });
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write('\n');
    }, 20_000);
    res.on('close', () => {
      clearInterval(ping);
      leave();
    });
    send({ type: 'lead', state: detail.lead, questions: detail.leadQuestions });
    for (const live of this.live.snapshot(roomId)) send({ type: 'live', live });
    for (const event of detail.events) {
      if (event.seq <= last) continue;
      last = event.seq;
      send({ type: 'event', event });
    }
  }
}

@ApiTags('a2a')
@Controller('.well-known')
@UseGuards(RoomsEnabledGuard)
export class A2aWellKnownController {
  static readonly CARD = { path: '.well-known/agent-card.json', method: RequestMethod.GET };

  constructor(private readonly server: RoomA2aServer) {}

  @Get('agent-card.json')
  @ApiOperation({
    summary: 'Get the A2A agent card at the well-known address',
    description:
      'The A2A 1.0 agent card at the address A2A clients look for, outside /api. It names two JSON-RPC interfaces: this server’s /api/a2a, which needs the pi-kit token as a bearer token, and the pi-kit-peer interface paired pi-kits use. Asks for the token like every other route.',
  })
  @Responds(A2aJsonSchema)
  @Fails({ 404: ROOMS_OFF })
  card(@Req() req: Request): Promise<Record<string, unknown>> {
    return this.server.card(`${req.protocol}://${req.get('host') ?? 'localhost'}`);
  }
}

@ApiTags('a2a')
@Controller('a2a')
@UseGuards(RoomsEnabledGuard)
export class A2aController {
  constructor(private readonly server: RoomA2aServer) {}

  @Remote()
  @Get('.well-known/agent-card.json')
  @ApiOperation({
    summary: 'Get the A2A agent card',
    description:
      'The A2A 1.0 agent card of this environment: a pi-kit coding agent that takes room tasks over JSON-RPC with push notifications.',
  })
  @Responds(A2aJsonSchema)
  @Fails({ 404: ROOMS_OFF })
  card(): Promise<Record<string, unknown>> {
    return this.server.card();
  }

  @Remote()
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Call the A2A agent',
    description:
      'The A2A 1.0 JSON-RPC endpoint, served by the A2A JavaScript SDK. SendMessage starts a room task (with the room-task extension, declared in A2A-Extensions) or answers its questions; GetTask, ListTasks and CancelTask work on the caller’s tasks. SendStreamingMessage and SubscribeToTask answer with Server-Sent Events, one JSON-RPC response per event, until the task ends or stops for input. Progress and results also go to the push notification URL given with the task.',
  })
  @Streams(
    A2aJsonSchema,
    'A JSON-RPC response as JSON, or for SendStreamingMessage and SubscribeToTask one JSON-RPC response per event.',
    'text/event-stream',
  )
  @ApiProduces('application/json', 'text/event-stream')
  @Fails({ 404: ROOMS_OFF })
  async rpc(
    @Headers(PeerProxy.CALLER_HEADER) caller: string | undefined,
    @Headers(A2A_VERSION_HEADER) version: string | undefined,
    @Headers(A2A_EXTENSIONS_HEADER) extensions: string | undefined,
    @Body({ schema: A2aJsonSchema }) body: Record<string, unknown>,
    @Query({ schema: A2aServiceParametersSchema }) query: z.infer<typeof A2aServiceParametersSchema>,
    @Res() res: Response,
  ): Promise<void> {
    const answer = await this.server.serve(
      caller,
      version ?? query['A2A-Version'],
      extensions ?? query['A2A-Extensions'],
      body,
    );
    if (!(Symbol.asyncIterator in answer)) {
      res.status(200).json(answer);
      return;
    }
    res.status(200).set(SSE_HEADERS);
    res.flushHeaders();
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 20_000);
    res.on('close', () => {
      clearInterval(ping);
      void answer.return(undefined);
    });
    try {
      for await (const event of answer) {
        if (res.writableEnded) break;
        res.write(formatSSEEvent(event));
      }
    } catch (error) {
      if (!res.writableEnded)
        res.write(
          formatSSEErrorEvent({
            jsonrpc: '2.0',
            id: (body['id'] as string | number | null | undefined) ?? null,
            error: JsonRpcTransportHandler.mapToJSONRPCError(error),
          }),
        );
    } finally {
      clearInterval(ping);
      if (!res.writableEnded) res.end();
    }
  }
}
