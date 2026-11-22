import { Injectable } from '@nestjs/common';
import type { BaseEvent } from '@ag-ui/core';
import type { PlaybookAgentSettings, RoomTask, RoomTaskQuestion } from '@pi-kit/protocol';
import { AguiService } from '../agui/agui.service';
import { numstat } from '../changes/git';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsService } from '../threads/threads.service';
import { changedFiles, out } from '../worktree/worktree-git';
import { RoomAgents } from './room-agents';
import { RoomQuestions, type WorkerAnswers } from './room-questions';

export interface WorkerJob {
  project: string;
  title: string;
  brief: string;
  acceptance: string;
  base: string;
  from?: string;
  feedback?: string;
  round?: number;
  onThread: (threadId: string) => Promise<void>;
  onStarted?: (started: { branch: string | null; folder: string; note?: string }) => Promise<void>;
  onQuestion?: (questions: RoomTaskQuestion[]) => Promise<WorkerAnswers | undefined>;
  observe?: (event: BaseEvent) => void;
  settings?: PlaybookAgentSettings;
}

export interface WorkerOutcome {
  state: Extract<RoomTask['state'], 'submitted' | 'failed' | 'stopped'>;
  folder: string | null;
  branch: string | null;
  head: string | null;
  report: string | null;
  files: RoomTask['files'];
  note: string;
}

@Injectable()
export class RoomWorkerRunner {
  constructor(
    private readonly threads: ThreadsService,
    private readonly agui: AguiService,
    private readonly sessions: PiSessionService,
    private readonly agents: RoomAgents,
  ) {}

  async run(job: WorkerJob): Promise<WorkerOutcome> {
    let folder: string | null = null;
    let branch: string | null = null;
    try {
      const detail = await this.threads.create(
        job.project,
        `Room task: ${job.title}`.slice(0, 200),
        { base: job.from ?? job.base, name: job.title, setup: null },
        undefined,
        { onId: job.onThread },
      );
      folder = detail.worktree?.path ?? null;
      branch = detail.worktree?.branch ?? null;
      if (!folder) throw new Error('The worker’s worktree was not created.');
      const unavailable = await this.agents.sandbox(detail.id);
      await this.agents.configure(detail.id, job.settings);
      await job.onStarted?.({
        branch,
        folder,
        ...(unavailable ? { note: `${unavailable} The worker runs in its worktree without it.` } : {}),
      });
      let result = await this.agui.runHeadless(detail.id, this.prompt(job), {
        cwd: folder,
        ...(job.observe ? { observe: job.observe } : {}),
      });
      while (result.status === 'interrupted' && job.onQuestion) {
        const questions = RoomQuestions.fromDialogs(this.sessions.pendingDialogs(detail.id));
        if (questions.length === 0) break;
        const answers = await job.onQuestion(questions);
        if (!answers) {
          await this.sessions.abort(detail.id).catch(() => undefined);
          return this.ended('stopped', folder, branch, `The worker on “${job.title}” was stopped.`);
        }
        result = await this.agui.resumeHeadless(detail.id, RoomQuestions.toResume(answers), {
          cwd: folder,
          ...(job.observe ? { observe: job.observe } : {}),
        });
      }
      if (result.status === 'interrupted') {
        await this.sessions.abort(detail.id).catch(() => undefined);
        return this.ended(
          'stopped',
          folder,
          branch,
          `The worker on “${job.title}” stopped at a question nobody could answer.`,
        );
      }
      if (result.status !== 'finished')
        return this.ended(
          result.status === 'aborted' ? 'stopped' : 'failed',
          folder,
          branch,
          result.status === 'aborted'
            ? `The worker on “${job.title}” was stopped.`
            : `The worker on “${job.title}” failed: ${result.error ?? 'pi reported an error.'}`,
        );
      const report = (await this.agents.lastReply(detail.id)) ?? null;
      if ((await changedFiles(folder)).length > 0) {
        await out(folder, ['add', '-A', '--', '.']);
        await out(folder, ['commit', '--quiet', '-m', `Room task: ${job.title}`], { identity: true });
      }
      const head = (await out(folder, ['rev-parse', 'HEAD'])).trim();
      const files = [...(await numstat(folder, job.base, head))].map(([path, counts]) => ({
        path,
        added: counts?.added ?? 0,
        removed: counts?.removed ?? 0,
      }));
      return {
        state: 'submitted',
        folder,
        branch,
        head,
        report,
        files,
        note: files.length
          ? `The worker finished “${job.title}”: ${files.length} file${files.length === 1 ? '' : 's'} changed, ready for review.`
          : `The worker finished “${job.title}” without changing files.`,
      };
    } catch (error) {
      return this.ended(
        'failed',
        folder,
        branch,
        `The worker on “${job.title}” could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private ended(
    state: WorkerOutcome['state'],
    folder: string | null,
    branch: string | null,
    note: string,
  ): WorkerOutcome {
    return { state, folder, branch, head: null, report: null, files: [], note };
  }

  private prompt(job: WorkerJob): string {
    return [
      `You are a worker in a pi-kit room. Your task: ${job.title}`,
      job.brief,
      job.acceptance ? `It is done when:\n\n${job.acceptance}` : '',
      job.feedback
        ? `This is round ${job.round ?? 2}. Your earlier work on this task is already committed in this worktree. The reviewer asks for these changes:\n\n${job.feedback}`
        : '',
      'If something you need is not in the brief, ask with ask_user before guessing: the room’s lead or its owner answers.',
      'Work only in this worktree. Do not commit, push or switch branches; pi-kit commits your changes when you finish. End with a short report: what you changed, how you checked it, and anything left open.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
