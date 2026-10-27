// @pi-kit/meat-proxy: `/score [thread]` tells how much of a finished thread's outcome the person steered.
//
// It is a plain pi extension. Everything it needs from pi-kit it asks for over pi's shared event bus (`pi.events`), the plugin API of doc/docs/plugins.md:
//   pi-kit:thread:outcome        how the thread ended, its diff, the labels stored so far     pi-kit:thread:transcript    the reduced, redacted thread with its turns
//   pi-kit:thread:baselines      the files pi edited                                          pi-kit:thread:outside-edits files changed by hand while the thread ran
//   pi-kit:attendant:run         one capped model call (task `score`)                         pi-kit:thread:annotate      hand the labels and the scores back to be stored
// A request is { requestId, ...params }; pi-kit says `<channel>:accepted` for it inside the emit and answers on `<channel>:reply` with the same requestId. In a host that is
// not pi-kit nothing accepts it, and the command says so at once.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { scoreThread } from '../lib/pipeline.mjs';

const CHANNEL = {
  outcome: 'pi-kit:thread:outcome',
  transcript: 'pi-kit:thread:transcript',
  baselines: 'pi-kit:thread:baselines',
  outsideEdits: 'pi-kit:thread:outside-edits',
  attendant: 'pi-kit:attendant:run',
  annotate: 'pi-kit:thread:annotate',
} as const;

interface Reply {
  requestId: string;
  ok: boolean;
  error?: string;
  code?: string;
  model?: string;
  [key: string]: unknown;
}

const NO_HOST = 'pi-kit is not here. /score needs pi-kit (the desktop app) for the thread database and the model call.';

/**
 * One request to pi-kit. pi's bus is synchronous: pi-kit says `<channel>:accepted` for the request's id inside the `emit`, before it works on the request, so when the emit
 * returns without that nobody is listening and the request fails at once; no clock decides whether pi-kit is there. The reply comes on `<channel>:reply` when pi-kit has it,
 * however long a model takes; a session that closes first is answered by pi-kit as failed, so nothing here waits on a session that is gone.
 */
function ask(pi: ExtensionAPI, channel: string, params: Record<string, unknown>): Promise<Reply> {
  const requestId = `score-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    let accepted = false;
    const offAccepted = pi.events.on(`${channel}:accepted`, (data) => {
      if ((data as { requestId?: unknown } | undefined)?.requestId === requestId) accepted = true;
    });
    const offReply = pi.events.on(`${channel}:reply`, (data) => {
      const reply = data as Reply | undefined;
      if (!reply || reply.requestId !== requestId) return;
      offReply();
      resolve(reply);
    });
    pi.events.emit(channel, { requestId, ...params });
    offAccepted();
    if (accepted) return;
    offReply();
    reject(new Error(NO_HOST));
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('score', {
    description: 'Score this thread: how much of its outcome you steered (or /score <thread id>)',
    handler: async (args, ctx) => {
      const thread = (args ?? '').trim() || undefined;
      const on = thread ? { thread } : {};
      const host = (consent: boolean) => ({
        outcome: () => ask(pi, CHANNEL.outcome, { ...on, diff: true, annotations: true }),
        transcript: () => ask(pi, CHANNEL.transcript, on),
        baselines: () => ask(pi, CHANNEL.baselines, on),
        outsideEdits: () => ask(pi, CHANNEL.outsideEdits, on),
        run: (prompt: { system: string; user: string }) => ask(pi, CHANNEL.attendant, { ...on, task: 'score', ...(consent ? { consent: true } : {}), ...prompt }),
        annotate: (body: Record<string, unknown>) => ask(pi, CHANNEL.annotate, { ...on, ...body }),
      });
      try {
        ctx.ui.notify('Weighing the thread’s outcome against what you did…', 'info');
        let result = (await scoreThread(host(false))) as Reply & { scores?: { line: string } };
        if (!result.ok && result.code === 'consent') {
          // The attendant is off: sending the transcript to a model is the person's decision, once per thread.
          const agreed = await ctx.ui.confirm('Score this thread?', String(result.error));
          if (!agreed) return void ctx.ui.notify('Nothing was sent. The thread was not scored.', 'info');
          result = (await scoreThread(host(true))) as typeof result;
        }
        if (!result.ok) return void ctx.ui.notify(String(result.error ?? 'The thread could not be scored.'), result.code === 'not-found' || result.code === 'invalid' ? 'info' : 'error');
        ctx.ui.notify(`${result.scores?.line ?? 'Scored.'}. The hunks carry their labels in the Outcome view; you can correct any of them there.`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
