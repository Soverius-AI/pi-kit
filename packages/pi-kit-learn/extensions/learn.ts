// @pi-kit/learn: `/learn [thread]` drafts a skill from a finished thread, `/learn verify [thread]` replays the draft from the thread's base commit.
//
// It is a plain pi extension. Everything it needs from pi-kit it asks for over pi's shared event bus (`pi.events`), the plugin API of doc/docs/plugins.md:
//   pi-kit:thread:transcript  the thread, reduced and redacted
//   pi-kit:attendant:run      one capped model call
//   pi-kit:learn:draft        hand the draft back (pi-kit stores it, pending)
//   pi-kit:learn:verified     replay the draft from the base commit in a scratch worktree and answer with the report
// A request is { requestId, ...params }; pi-kit says `<channel>:accepted` for it inside the emit and answers on `<channel>:reply` with the same requestId. In a host that is
// not pi-kit nothing accepts it, and the command says so at once.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { buildAnalysisPrompt, parseDraftReply } from '../lib/analysis.mjs';
import { describeVerification } from '../lib/verification.mjs';

const CHANNEL = {
  transcript: 'pi-kit:thread:transcript',
  attendant: 'pi-kit:attendant:run',
  draft: 'pi-kit:learn:draft',
  verified: 'pi-kit:learn:verified',
} as const;

interface Reply {
  requestId: string;
  ok: boolean;
  error?: string;
  code?: string;
  model?: string;
  [key: string]: unknown;
}

const NO_HOST = 'pi-kit is not here. /learn needs pi-kit (the desktop app) for the thread database and the model call.';

/**
 * One request to pi-kit. pi's bus is synchronous: pi-kit says `<channel>:accepted` for the request's id inside the `emit`, before it works on the request, so when the emit
 * returns without that nobody is listening and the request fails at once; no clock decides whether pi-kit is there. The reply comes on `<channel>:reply` when pi-kit has it,
 * however long a model call or a replay takes; a session that closes first is answered by pi-kit as failed, so nothing here waits on a session that is gone.
 */
function ask(pi: ExtensionAPI, channel: string, params: Record<string, unknown>): Promise<Reply> {
  const requestId = `learn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
  pi.registerCommand('learn', {
    description: 'Draft a skill from this thread (or /learn <thread id>); you read it and approve it in pi-kit. /learn verify replays the draft from the thread’s base commit',
    handler: async (args, ctx) => {
      const word = (args ?? '').trim();
      const [first, ...rest] = word.split(/\s+/);
      if (first === 'verify') {
        const target = rest.join(' ').trim() || undefined;
        try {
          // The reply comes when the replay is over; pi-kit has the thread "Verify: <name>" in the sidebar while it runs.
          ctx.ui.notify('Replaying the draft skill from the thread’s base commit in a scratch worktree. Watch the thread “Verify: …” in the sidebar; this takes a while.', 'info');
          const reply = await ask(pi, CHANNEL.verified, { ...(target ? { thread: target } : {}) });
          if (!reply.ok) return void ctx.ui.notify(String(reply.error ?? 'pi-kit could not verify the draft.'), 'error');
          const draft = reply['draft'] as { name: string } | undefined;
          const { text, level } = describeVerification(reply['verification'] as Record<string, unknown> | null, draft?.name ?? 'the draft');
          ctx.ui.notify(text, level);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
        return;
      }
      const thread = word || undefined;
      try {
        const transcript = await ask(pi, CHANNEL.transcript, { ...(thread ? { thread } : {}) });
        if (!transcript.ok) return void ctx.ui.notify(String(transcript.error ?? 'pi-kit could not read the thread.'), 'error');
        // A thread has one draft; do not spend a model call on a thread that has it already.
        const existing = transcript['draft'] as { name: string; state: string } | null | undefined;
        if (existing) {
          const what = { pending: 'Read it in the card at the end of the thread.', approved: 'It was approved: the skill exists.', discarded: 'You discarded it; reopen it from the thread’s menu.' }[existing.state] ?? '';
          return void ctx.ui.notify(`This thread has a skill draft already: ${existing.name}. ${what}`, 'info');
        }
        const prompt = buildAnalysisPrompt(transcript['transcript'] as never);
        ctx.ui.notify('Reading the thread and drafting a skill…', 'info');

        let answer = await ask(pi, CHANNEL.attendant, { ...(thread ? { thread } : {}), task: 'learn', ...prompt });
        if (!answer.ok && answer.code === 'consent') {
          // The attendant is off: sending the transcript to a model is the person's decision, once per thread.
          const agreed = await ctx.ui.confirm('Learn a skill from this thread?', String(answer.error));
          if (!agreed) return void ctx.ui.notify('Nothing was sent. No draft was made.', 'info');
          answer = await ask(pi, CHANNEL.attendant, { ...(thread ? { thread } : {}), task: 'learn', consent: true, ...prompt });
        }
        if (!answer.ok) return void ctx.ui.notify(String(answer.error ?? 'The model call failed.'), 'error');

        const parsed = parseDraftReply(String(answer['text'] ?? ''));
        if (!parsed.ok) {
          return void ctx.ui.notify(parsed.skip ? `Nothing in this thread generalises: ${parsed.reason}` : `The model’s answer was not a skill: ${parsed.reason}`, parsed.skip ? 'info' : 'warning');
        }
        const stored = await ask(pi, CHANNEL.draft, { ...(thread ? { thread } : {}), text: parsed.text, model: answer['model'] });
        if (!stored.ok) return void ctx.ui.notify(String(stored.error ?? 'pi-kit could not keep the draft.'), 'error');
        ctx.ui.notify(`Drafted the skill ${parsed.name}. Read it in the card at the end of the thread, then approve it or discard it.`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
