import { Injectable, type OnModuleInit } from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Message, TaskArtifactUpdateEvent, TaskState, type Task } from '@a2a-js/sdk';
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import {
  A2A_ROOM_EXTENSION,
  A2aRoomConsultSchema,
  type A2aRoomConsult,
  type A2aRoomTaskOffer,
  type A2aRoomTaskProgress,
  type RoomTaskQuestion,
  type RoomTaskReport,
} from '@pi-kit/protocol';
import { InstanceRepository } from '../db/instance.repository';
import { MetaRepository } from '../db/meta.repository';
import { RoomsRepository } from '../db/rooms.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { out } from '../worktree/worktree-git';
import { RepositoryIdentity } from './repository-identity';
import { RoomA2a } from './room-a2a';
import { RoomA2aPushSender } from './room-a2a.push-sender';
import { RoomA2aTaskStore } from './room-a2a.task-store';
import { RoomConsultant } from './room-consultant.service';
import { RoomFolders } from './room-folders';
import { LiveFeed } from './room-live';
import { RoomOutbox } from './room-outbox';
import { RoomQuestions } from './room-questions';
import { RoomWorkerRunner, type WorkerOutcome } from './room-worker-runner';

export const NOT_THE_HOST = 'Only the room’s host may send this.';
export const NO_CLONE = 'No project on this computer is a clone of that repository with the base commit.';
export const BAD_PUSH_URL = 'Push notifications go only to the pi-kit that sent the task.';
export const BUNDLE_LIMIT = 20 * 1024 * 1024;

type Offer = A2aRoomTaskOffer & { hostInstanceId: string; a2aTaskId: string };

interface Job {
  offer: Offer;
  bus: ExecutionEventBus;
  asked: RoomTaskQuestion[];
  turn: Turn;
}

class Turn {
  readonly promise: Promise<void>;
  resolve: () => void = () => undefined;

  constructor() {
    this.promise = new Promise<void>((resolve) => (this.resolve = resolve));
  }
}

@Injectable()
export class RoomWorkerService implements AgentExecutor, OnModuleInit {
  static readonly LIVE_EVERY = 250;
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly rooms: RoomsRepository,
    private readonly meta: MetaRepository,
    private readonly instance: InstanceRepository,
    private readonly runner: RoomWorkerRunner,
    private readonly sessions: PiSessionService,
    private readonly questions: RoomQuestions,
    private readonly store: RoomA2aTaskStore,
    private readonly sender: RoomA2aPushSender,
    private readonly outbox: RoomOutbox,
    private readonly consultant: RoomConsultant,
    private readonly folders: RoomFolders,
  ) {}

  onModuleInit(): void {
    void this.recover();
  }

  async recover(): Promise<void> {
    for (const task of await this.rooms.runningWorkerTasks()) {
      await this.rooms.updateWorkerTask(task.taskId, { state: 'failed' });
      if (!task.a2aTaskId) continue;
      const failed = RoomA2a.task(
        task.a2aTaskId,
        task.roomId,
        TaskState.TASK_STATE_FAILED,
        this.progress(task.taskId, task.attempt),
        { note: 'The worker’s pi-kit restarted while the task ran. Approve it again to run it once more.' },
      );
      await this.store.saveFor(task.hostInstanceId, failed);
      await this.sender.send({ payload: { $case: 'task', value: failed } }, undefined, failed);
    }
    await this.outbox.flush();
  }

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    if (context.task) return await this.resume(context, bus);
    const user = context.context.user;
    const caller = user?.isAuthenticated ? user.userName : undefined;
    const message = context.userMessage;
    const consult = A2aRoomConsultSchema.safeParse(message.metadata?.[A2A_ROOM_EXTENSION]);
    if (consult.success) return await this.consult(context, bus, consult.data, caller);
    const offer = RoomA2a.readOffer(message);
    const reject = (note: string) =>
      bus.publish(
        AgentEvent.task(
          RoomA2a.task(
            context.taskId,
            context.contextId,
            TaskState.TASK_STATE_REJECTED,
            offer ? this.progress(offer.taskId, offer.attempt) : null,
            {
              note,
              history: [message],
            },
          ),
        ),
      );
    if (!offer)
      return reject('This agent takes pi-kit room tasks only: send the room-task extension with the message.');
    if (!caller) return reject(NOT_THE_HOST);
    const push = context.request.configuration?.taskPushNotificationConfig;
    if (push && RoomA2a.parsePeerUrl(push.url)?.instanceId !== caller) return reject(BAD_PUSH_URL);
    const existing = await this.rooms.workerTask(offer.taskId);
    if (existing && existing.hostInstanceId !== caller) return reject(NOT_THE_HOST);
    if (existing && existing.attempt >= offer.attempt && existing.state === 'running')
      return reject(`This attempt already runs here as task ${existing.a2aTaskId ?? existing.taskId}.`);
    const project = await RepositoryIdentity.findClone(this.meta, offer.repository, offer.base);
    if (!project)
      return reject(
        `No project on this computer is a clone of ${offer.repository} with commit ${offer.base.slice(0, 7)}. Open one in pi-kit and fetch, then try again.`,
      );
    await this.rooms.insertWorkerTask({
      taskId: offer.taskId,
      roomId: offer.roomId,
      hostInstanceId: caller,
      attempt: offer.attempt,
      folder: project,
      pushUrl: push?.url ?? null,
      pushToken: push?.token ?? null,
      a2aTaskId: context.taskId,
    });
    const job: Job = {
      offer: { ...offer, hostInstanceId: caller, a2aTaskId: context.taskId },
      bus,
      asked: [],
      turn: new Turn(),
    };
    this.jobs.set(context.taskId, job);
    bus.publish(
      AgentEvent.task(
        RoomA2a.task(
          context.taskId,
          offer.roomId,
          TaskState.TASK_STATE_WORKING,
          this.progress(offer.taskId, offer.attempt),
          {
            history: [message],
          },
        ),
      ),
    );
    void this.work(job, project);
    await job.turn.promise;
  }

  private async consult(
    context: RequestContext,
    bus: ExecutionEventBus,
    consult: A2aRoomConsult,
    caller: string | undefined,
  ): Promise<void> {
    const end = (state: TaskState, note: string) =>
      bus.publish(
        AgentEvent.task(
          RoomA2a.task(context.taskId, context.contextId, state, null, { note, history: [context.userMessage] }),
        ),
      );
    if (!caller) return end(TaskState.TASK_STATE_REJECTED, NOT_THE_HOST);
    const personal = !consult.base && !consult.repository;
    const project = personal
      ? this.folders.workspace(`consult-${createHash('sha256').update(`${caller}:${consult.roomId}`).digest('hex')}`)
      : await RepositoryIdentity.findClone(this.meta, consult.repository, consult.base);
    if (!project)
      return end(
        TaskState.TASK_STATE_REJECTED,
        `No project on this computer is a clone of ${consult.repository} with commit ${consult.base.slice(0, 7)}.`,
      );
    bus.publish(
      AgentEvent.task(
        RoomA2a.task(context.taskId, context.contextId, TaskState.TASK_STATE_WORKING, null, {
          history: [context.userMessage],
        }),
      ),
    );
    const feed = this.feed(() => bus, context.taskId, context.contextId);
    const done = (async () => {
      let answer: string;
      let state = TaskState.TASK_STATE_COMPLETED;
      try {
        answer = await this.consultant.ask({
          roomId: `${caller}:${consult.roomId}`,
          roomTitle: consult.roomTitle,
          repository: consult.repository,
          folder: project,
          role: consult.role,
          instructions: consult.instructions,
          question: consult.question,
          settings: consult.settings,
          detached: true,
          observe: feed.observe,
        });
      } catch (error) {
        answer = error instanceof Error ? error.message : String(error);
        state = TaskState.TASK_STATE_FAILED;
      }
      feed.end();
      bus.publish(
        AgentEvent.artifactUpdate(
          TaskArtifactUpdateEvent.fromJSON({
            taskId: context.taskId,
            contextId: context.contextId,
            artifact: { artifactId: 'answer', name: 'Answer', parts: [{ text: answer, mediaType: 'text/markdown' }] },
            append: false,
            lastChunk: true,
          }),
        ),
      );
      bus.publish(AgentEvent.statusUpdate(RoomA2a.statusUpdate(context.taskId, context.contextId, state, null, null)));
    })();
    await done;
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const job = this.jobs.get(taskId);
    if (job) {
      job.bus = bus;
      this.questions.cancel(job.offer.taskId);
      const row = await this.rooms.workerTask(job.offer.taskId);
      if (row?.workerThreadId) await this.sessions.abort(row.workerThreadId).catch(() => undefined);
      return;
    }
    const row = await this.rooms.workerTaskByA2a(taskId);
    bus.publish(
      AgentEvent.statusUpdate(
        RoomA2a.statusUpdate(
          taskId,
          row?.roomId ?? '',
          TaskState.TASK_STATE_CANCELED,
          'The task no longer runs here.',
          row ? this.progress(row.taskId, row.attempt) : null,
        ),
      ),
    );
  }

  private async resume(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const task = context.task as Task;
    const job = this.jobs.get(task.id);
    const user = context.context.user;
    if (!job || !user?.isAuthenticated || user.userName !== job.offer.hostInstanceId || !job.asked.length) {
      bus.publish(AgentEvent.message(this.reply(task, 'The worker no longer waits for an answer.')));
      return;
    }
    const answers = RoomA2a.readAnswers(context.userMessage, job.asked);
    if (!answers) {
      bus.publish(AgentEvent.message(this.reply(task, 'The answer names none of the open questions.')));
      return;
    }
    job.bus = bus;
    job.turn = new Turn();
    bus.publish(
      AgentEvent.task({
        ...task,
        status: RoomA2a.statusUpdate(
          task.id,
          task.contextId,
          TaskState.TASK_STATE_WORKING,
          null,
          this.progress(job.offer.taskId, job.offer.attempt),
        ).status,
      }),
    );
    job.asked = [];
    if (!this.questions.answer(job.offer.taskId, answers)) job.turn.resolve();
    await job.turn.promise;
  }

  private async work(job: Job, project: string): Promise<void> {
    const { offer } = job;
    const progress = (extra: Partial<A2aRoomTaskProgress> = {}) => ({
      ...this.progress(offer.taskId, offer.attempt),
      ...extra,
    });
    const feed = this.feed(() => job.bus, offer.a2aTaskId, offer.roomId);
    const outcome = await this.runner.run({
      project,
      title: offer.title,
      brief: offer.brief,
      acceptance: offer.acceptance,
      base: offer.base,
      ...(offer.from ? { from: offer.from } : {}),
      ...(offer.feedback ? { feedback: offer.feedback } : {}),
      ...(offer.round ? { round: offer.round } : {}),
      onThread: async (threadId) => await this.rooms.updateWorkerTask(offer.taskId, { workerThreadId: threadId }),
      onStarted: async ({ branch, note }) => {
        job.bus.publish(
          AgentEvent.statusUpdate(
            RoomA2a.statusUpdate(
              offer.a2aTaskId,
              offer.roomId,
              TaskState.TASK_STATE_WORKING,
              note ?? null,
              progress({ branch }),
            ),
          ),
        );
      },
      onQuestion: async (questions) => {
        const answered = this.questions.ask(offer.taskId);
        job.asked = questions;
        job.bus.publish(
          AgentEvent.statusUpdate(
            RoomA2a.statusUpdate(
              offer.a2aTaskId,
              offer.roomId,
              TaskState.TASK_STATE_INPUT_REQUIRED,
              questions.map((question) => question.title).join('\n'),
              progress({ questions }),
            ),
          ),
        );
        job.turn.resolve();
        return await answered;
      },
      observe: feed.observe,
    });
    feed.end();
    const report = await this.package(offer, outcome);
    await this.rooms.updateWorkerTask(offer.taskId, { state: report.state === 'running' ? 'running' : report.state });
    for (const artifact of RoomA2a.artifactUpdates(offer.a2aTaskId, offer.roomId, report))
      job.bus.publish(AgentEvent.artifactUpdate(artifact));
    job.bus.publish(
      AgentEvent.statusUpdate(
        RoomA2a.statusUpdate(
          offer.a2aTaskId,
          offer.roomId,
          RoomA2a.endState(report.state),
          report.note,
          progress({ branch: report.branch, head: report.head, files: report.files }),
        ),
      ),
    );
    this.jobs.delete(offer.a2aTaskId);
    job.turn.resolve();
  }

  private feed(bus: () => ExecutionEventBus, taskId: string, contextId: string): LiveFeed {
    return new LiveFeed(RoomWorkerService.LIVE_EVERY, (piece) =>
      bus().publish(AgentEvent.artifactUpdate(RoomA2a.liveUpdate(taskId, contextId, piece))),
    );
  }

  private reply(task: Task, text: string): Message {
    return Message.fromJSON({
      messageId: randomUUID(),
      taskId: task.id,
      contextId: task.contextId,
      role: 'ROLE_AGENT',
      parts: [{ text, mediaType: 'text/plain' }],
    });
  }

  private progress(taskId: string, attempt: number): A2aRoomTaskProgress {
    return { taskId, attempt, environmentId: this.instance.instanceId };
  }

  private async package(offer: Offer, outcome: WorkerOutcome): Promise<RoomTaskReport> {
    const report: RoomTaskReport = {
      attempt: offer.attempt,
      environmentId: this.instance.instanceId,
      state: outcome.state,
      branch: outcome.branch,
      head: outcome.head,
      report: outcome.report,
      files: outcome.files,
      bundle: null,
      note: outcome.note,
      questions: [],
    };
    if (outcome.state !== 'submitted' || !outcome.folder || !outcome.head || outcome.head === offer.base) return report;
    const scratch = mkdtempSync(join(tmpdir(), 'pk-room-bundle-'));
    try {
      const file = join(scratch, 'task.bundle');
      const ref = outcome.branch ? `refs/heads/${outcome.branch}` : 'HEAD';
      await out(outcome.folder, ['bundle', 'create', '--quiet', file, ref, `^${offer.base}`]);
      const bytes = readFileSync(file);
      if (bytes.length > BUNDLE_LIMIT)
        return {
          ...report,
          state: 'failed',
          note: `The result of “${offer.title}” is ${Math.round(bytes.length / 1024 / 1024)} MB; rooms carry at most 20 MB between machines for now.`,
        };
      return { ...report, bundle: bytes.toString('base64') };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
