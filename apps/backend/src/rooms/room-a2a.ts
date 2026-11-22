import { randomUUID } from 'node:crypto';
import {
  AgentCard,
  Message,
  SendMessageRequest,
  StreamResponse,
  Task,
  TaskState,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  taskStateToJSON,
} from '@a2a-js/sdk';
import {
  A2A_BUNDLE_MEDIA_TYPE,
  A2A_PEER_SCHEME,
  A2A_ROOM_EXTENSION,
  A2A_VERSION,
  A2aRoomTaskOfferSchema,
  A2aRoomTaskProgressSchema,
  RoomTaskAnswerSchema,
  type A2aRoomTaskOffer,
  type A2aRoomTaskProgress,
  type RoomTaskAnswer,
  type RoomTaskQuestion,
  type RoomTaskReport,
} from '@pi-kit/protocol';

export const A2A_PATH = '/api/a2a';
export const A2A_CARD_PATH = '/api/a2a/.well-known/agent-card.json';
export const A2A_PUSH_PATH = '/api/rooms/a2a/push';

import type { LivePiece } from './room-live';

type Json = Record<string, unknown>;

export class RoomA2a {
  static readonly LIVE = 'live';

  static peerUrl(instanceId: string, path: string): string {
    return `${A2A_PEER_SCHEME}//${instanceId}${path}`;
  }

  static parsePeerUrl(url: string): { instanceId: string; path: string } | undefined {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== A2A_PEER_SCHEME || !parsed.host || !parsed.pathname.startsWith('/api/')) return undefined;
      return { instanceId: parsed.host, path: parsed.pathname };
    } catch {
      return undefined;
    }
  }

  static card(name: string, version: string, instanceId: string, origin?: string): AgentCard {
    return AgentCard.fromJSON({
      name: `pi-kit on ${name}`,
      description:
        'A pi-kit coding agent. It takes a task with a brief and acceptance criteria, works in its own git worktree of the repository at the given commit, and returns a report and the commits.',
      supportedInterfaces: [
        ...(origin ? [{ url: `${origin}${A2A_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION }] : []),
        { url: RoomA2a.peerUrl(instanceId, A2A_PATH), protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION },
      ],
      ...(origin
        ? {
            securitySchemes: {
              bearer: {
                httpAuthSecurityScheme: {
                  scheme: 'Bearer',
                  description:
                    'The token of this pi-kit (PI_KIT_TOKEN). Paired pi-kits use the pi-kit-peer interface, which runs over their signed peer session instead.',
                },
              },
            },
            securityRequirements: [{ schemes: { bearer: { list: [] } } }],
          }
        : {}),
      provider: { organization: 'pi-kit', url: 'https://pi-kit.dev' },
      version,
      capabilities: {
        streaming: true,
        pushNotifications: true,
        extensions: [
          {
            uri: A2A_ROOM_EXTENSION,
            description:
              'Room tasks: the repository and base commit to work from, the worker’s questions and the owner’s answers, and the changed files.',
            required: true,
          },
        ],
      },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'text/markdown', 'application/json', A2A_BUNDLE_MEDIA_TYPE],
      skills: [
        {
          id: 'room-task',
          name: 'Room task',
          description: 'Implements one task of a pi-kit room in a worktree and returns the commits as a git bundle.',
          tags: ['coding', 'git', 'pi-kit'],
          inputModes: ['application/json'],
          outputModes: ['text/markdown', A2A_BUNDLE_MEDIA_TYPE],
        },
      ],
    });
  }

  static takesRoomTasks(card: AgentCard | undefined): boolean {
    return (
      !!card &&
      card.supportedInterfaces.some(
        (face) =>
          face.protocolBinding === 'JSONRPC' && face.protocolVersion.split('.')[0] === A2A_VERSION.split('.')[0],
      ) &&
      !!card.capabilities?.extensions?.some((extension) => extension.uri === A2A_ROOM_EXTENSION)
    );
  }

  static offer(offer: A2aRoomTaskOffer, push?: { url: string; token: string }): SendMessageRequest {
    return SendMessageRequest.fromJSON({
      message: {
        messageId: randomUUID(),
        contextId: offer.roomId,
        role: 'ROLE_USER',
        parts: [
          {
            text: [
              `Task: ${offer.title}`,
              offer.brief,
              offer.acceptance ? `Done when: ${offer.acceptance}` : '',
              `Repository ${offer.repository} at ${offer.base}.`,
            ]
              .filter(Boolean)
              .join('\n\n'),
            mediaType: 'text/plain',
          },
        ],
        metadata: { [A2A_ROOM_EXTENSION]: offer },
        extensions: [A2A_ROOM_EXTENSION],
      },
      configuration: {
        acceptedOutputModes: ['text/markdown', 'text/plain', A2A_BUNDLE_MEDIA_TYPE],
        returnImmediately: true,
        ...(push ? { taskPushNotificationConfig: { url: push.url, token: push.token } } : {}),
      },
    });
  }

  static readOffer(message: Message): A2aRoomTaskOffer | undefined {
    const parsed = A2aRoomTaskOfferSchema.safeParse(message.metadata?.[A2A_ROOM_EXTENSION]);
    return parsed.success ? parsed.data : undefined;
  }

  static answers(
    a2aTaskId: string,
    contextId: string | undefined,
    answers: RoomTaskAnswer['answers'],
  ): SendMessageRequest {
    return SendMessageRequest.fromJSON({
      message: {
        messageId: randomUUID(),
        taskId: a2aTaskId,
        ...(contextId ? { contextId } : {}),
        role: 'ROLE_USER',
        parts: [{ text: answers.map((answer) => RoomA2a.plainAnswer(answer)).join('\n'), mediaType: 'text/plain' }],
        metadata: { [A2A_ROOM_EXTENSION]: { answers } },
        extensions: [A2A_ROOM_EXTENSION],
      },
      configuration: { returnImmediately: true },
    });
  }

  static readAnswers(message: Message, asked: readonly RoomTaskQuestion[]): RoomTaskAnswer['answers'] | undefined {
    const extension = message.metadata?.[A2A_ROOM_EXTENSION] as { answers?: unknown } | undefined;
    const parsed = RoomTaskAnswerSchema.safeParse({ answers: extension?.answers });
    if (parsed.success) return parsed.data.answers;
    const text = RoomA2a.text(message);
    const first = asked[0];
    if (!text || !first) return undefined;
    return [
      first.method === 'confirm'
        ? { id: first.id, confirmed: /^(y|yes|allow|ok|approve)\b/i.test(text) }
        : { id: first.id, value: text },
    ];
  }

  static task(
    id: string,
    roomId: string,
    state: TaskState,
    progress: A2aRoomTaskProgress | null,
    options: { note?: string | null; history?: Message[]; report?: RoomTaskReport } = {},
  ): Task {
    return Task.fromJSON({
      id,
      contextId: roomId,
      status: RoomA2a.status(state, options.note ?? null, id, roomId),
      artifacts: options.report ? RoomA2a.artifacts(options.report) : [],
      history: (options.history ?? []).map((message) => Message.toJSON(message)),
      metadata: progress ? { [A2A_ROOM_EXTENSION]: progress } : {},
    });
  }

  static statusUpdate(
    id: string,
    roomId: string,
    state: TaskState,
    text: string | null,
    progress: A2aRoomTaskProgress | null,
  ): TaskStatusUpdateEvent {
    return TaskStatusUpdateEvent.fromJSON({
      taskId: id,
      contextId: roomId,
      status: RoomA2a.status(state, text, id, roomId),
      metadata: progress ? { [A2A_ROOM_EXTENSION]: progress } : {},
    });
  }

  static liveUpdate(id: string, roomId: string, piece: LivePiece): TaskArtifactUpdateEvent {
    return TaskArtifactUpdateEvent.fromJSON({
      taskId: id,
      contextId: roomId,
      artifact: {
        artifactId: RoomA2a.LIVE,
        name: 'Live',
        parts: piece.text ? [{ text: piece.text, mediaType: 'text/plain' }] : [],
        metadata: { [A2A_ROOM_EXTENSION]: { activity: piece.activity } },
      },
      append: !piece.reset,
      lastChunk: piece.done,
    });
  }

  static live(response: StreamResponse, from: 'pi-kit' | 'outside'): LivePiece | undefined {
    if (response.payload?.$case !== 'artifactUpdate') return undefined;
    const update = response.payload.value;
    const artifact = update.artifact;
    if (!artifact || (from === 'pi-kit' && artifact.artifactId !== RoomA2a.LIVE)) return undefined;
    const text = artifact.parts.map((part) => (part.content?.$case === 'text' ? part.content.value : '')).join('');
    const activity = (artifact.metadata?.[A2A_ROOM_EXTENSION] as { activity?: unknown } | undefined)?.activity;
    if (from === 'outside' && (!text || update.lastChunk)) return undefined;
    return {
      text,
      reset: !update.append,
      activity: typeof activity === 'string' ? activity : null,
      done: from === 'pi-kit' && update.lastChunk,
    };
  }

  static async relay(
    stream: AsyncIterable<StreamResponse>,
    from: 'pi-kit' | 'outside',
    put: (piece: LivePiece) => void,
  ): Promise<void> {
    try {
      for await (const response of stream) {
        const piece = RoomA2a.live(response, from);
        if (piece) put(piece);
      }
    } catch {
      return;
    }
  }

  static artifactUpdates(id: string, roomId: string, report: RoomTaskReport): TaskArtifactUpdateEvent[] {
    return RoomA2a.artifacts(report).map((artifact) =>
      TaskArtifactUpdateEvent.fromJSON({ taskId: id, contextId: roomId, artifact, append: false, lastChunk: true }),
    );
  }

  static endState(state: RoomTaskReport['state']): TaskState {
    return state === 'submitted'
      ? TaskState.TASK_STATE_COMPLETED
      : state === 'stopped'
        ? TaskState.TASK_STATE_CANCELED
        : TaskState.TASK_STATE_FAILED;
  }

  static plainReport(
    task: Task,
    room: { taskId: string; attempt: number; environmentId: string; title: string; agent: string },
  ): RoomTaskReport {
    const extended = RoomA2a.report({ payload: { $case: 'task', value: task } });
    if (extended && extended.taskId === room.taskId)
      return { ...extended.report, attempt: room.attempt, environmentId: room.environmentId };
    const body = Task.toJSON(task) as {
      status?: { state?: string; message?: { messageId?: string; parts?: Json[] } };
      artifacts?: { parts?: Json[] }[];
    };
    const status = body.status ?? {};
    const state = RoomA2a.roomState(status.state);
    const parts = (body.artifacts ?? []).flatMap((artifact) => artifact.parts ?? []);
    const bundle = parts.find((part) => part['mediaType'] === A2A_BUNDLE_MEDIA_TYPE && part['raw'])?.['raw'];
    const text = parts
      .map((part) =>
        typeof part['text'] === 'string'
          ? part['text']
          : part['data'] !== undefined
            ? `\`\`\`json\n${JSON.stringify(part['data'], null, 2)}\n\`\`\``
            : typeof part['url'] === 'string'
              ? `${String(part['filename'] ?? 'File')}: ${part['url']}`
              : '',
      )
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 32_000);
    const said = (status.message?.parts ?? [])
      .map((part) => String(part['text'] ?? ''))
      .filter(Boolean)
      .join('\n');
    const asking = status.state === taskStateToJSON(TaskState.TASK_STATE_INPUT_REQUIRED);
    const auth = status.state === taskStateToJSON(TaskState.TASK_STATE_AUTH_REQUIRED);
    const end =
      state === 'submitted'
        ? `${room.agent} finished “${room.title}”.${typeof bundle === 'string' ? '' : ' It returned no commits; read its report.'}`
        : state === 'failed'
          ? `${room.agent} could not do “${room.title}”${said ? `: ${said}` : '.'}`
          : state === 'stopped'
            ? `${room.agent} stopped “${room.title}”.`
            : null;
    return {
      attempt: room.attempt,
      environmentId: room.environmentId,
      state: auth ? 'failed' : state,
      branch: null,
      head: null,
      report: text || (state === 'submitted' ? said || null : null),
      files: [],
      bundle: state === 'submitted' && typeof bundle === 'string' ? bundle : null,
      note: auth ? `${room.agent} asks to sign in, which pi-kit cannot do for it.` : end,
      questions: asking
        ? [
            {
              id: status.message?.messageId || 'input',
              method: 'input',
              title: (said || `${room.agent} asks for more input.`).slice(0, 2000),
            },
          ]
        : [],
    };
  }

  static report(response: StreamResponse): { taskId: string; a2aTaskId: string; report: RoomTaskReport } | undefined {
    const body = StreamResponse.toJSON(response) as { task?: Json; statusUpdate?: Json };
    const source = body.task ?? body.statusUpdate;
    if (!source) return undefined;
    const progress = A2aRoomTaskProgressSchema.safeParse(
      (source['metadata'] as Json | undefined)?.[A2A_ROOM_EXTENSION],
    );
    if (!progress.success) return undefined;
    const meta = progress.data;
    const status = (source['status'] ?? {}) as { state?: string; message?: { parts?: Json[] } };
    const artifacts = (body.task?.['artifacts'] ?? []) as { artifactId?: string; parts?: Json[] }[];
    const parts = artifacts.flatMap((artifact) => artifact.parts ?? []);
    const report = artifacts.find((artifact) => artifact.artifactId === 'report');
    const bundle = parts.find((part) => part['mediaType'] === A2A_BUNDLE_MEDIA_TYPE && part['raw'])?.['raw'];
    const state = RoomA2a.roomState(status.state);
    const asking = status.state === taskStateToJSON(TaskState.TASK_STATE_INPUT_REQUIRED);
    const note = (status.message?.parts ?? [])
      .map((part) => String(part['text'] ?? ''))
      .filter(Boolean)
      .join('\n');
    return {
      taskId: meta.taskId,
      a2aTaskId: String(source['id'] ?? source['taskId'] ?? ''),
      report: {
        attempt: meta.attempt,
        environmentId: meta.environmentId,
        state,
        branch: meta.branch ?? null,
        head: meta.head ?? null,
        report: report
          ? (report.parts ?? [])
              .map((part) => String(part['text'] ?? ''))
              .join('\n')
              .trim() || null
          : null,
        files: meta.files ?? [],
        bundle: state === 'submitted' && typeof bundle === 'string' ? bundle : null,
        note: asking ? null : note || null,
        questions: asking ? (meta.questions ?? []) : [],
      },
    };
  }

  static text(message: Message | undefined): string {
    return (message?.parts ?? [])
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  private static roomState(state: string | undefined): RoomTaskReport['state'] {
    switch (state) {
      case taskStateToJSON(TaskState.TASK_STATE_COMPLETED):
        return 'submitted';
      case taskStateToJSON(TaskState.TASK_STATE_CANCELED):
        return 'stopped';
      case taskStateToJSON(TaskState.TASK_STATE_FAILED):
      case taskStateToJSON(TaskState.TASK_STATE_REJECTED):
        return 'failed';
      default:
        return 'running';
    }
  }

  private static artifacts(report: RoomTaskReport): Json[] {
    const artifacts: Json[] = [];
    if (report.report)
      artifacts.push({
        artifactId: 'report',
        name: 'Report',
        parts: [{ text: report.report, mediaType: 'text/markdown' }],
      });
    if (report.bundle)
      artifacts.push({
        artifactId: 'changes',
        name: 'Changes',
        ...(report.branch ? { description: `The commits of ${report.branch} after the base commit.` } : {}),
        parts: [{ raw: report.bundle, mediaType: A2A_BUNDLE_MEDIA_TYPE, filename: 'task.bundle' }],
      });
    return artifacts;
  }

  private static status(state: TaskState, text: string | null, taskId: string, roomId: string): Json {
    return {
      state: taskStateToJSON(state),
      timestamp: new Date().toISOString(),
      ...(text
        ? {
            message: {
              messageId: randomUUID(),
              taskId,
              contextId: roomId,
              role: 'ROLE_AGENT',
              parts: [{ text, mediaType: 'text/plain' }],
            },
          }
        : {}),
    };
  }

  private static plainAnswer(answer: RoomTaskAnswer['answers'][number]): string {
    if (answer.cancelled) return 'Skip this.';
    if (answer.confirmed !== undefined) return answer.confirmed ? 'Yes' : 'No';
    return answer.value ?? '';
  }
}
