// pi-kit test extension for the human-in-the-loop blocks and the queue. createWorld() (e2e/support/env.mjs) copies it to
// <project>/.pi/extensions/pk-hitl.ts. It asks through all four dialogs of pi's ExtensionUIContext, guards one bash command
// (the queue tests hold a run open with `sleep` through the bash tool instead of a tool of their own: a small model that is offered an extra tool
// reaches for it in unrelated tests) and, for every answer, writes one JSON line to $PK_HITL_LOG: that file is pi's side of the story, which the tests read to
// check what the extension was given (`false` / `undefined` when the user cancelled).
import { appendFileSync } from 'node:fs';

const record = (kind: string, answer: unknown): void => {
  const file = process.env.PK_HITL_LOG;
  if (file) appendFileSync(file, `${JSON.stringify({ kind, answer: answer === undefined ? null : answer })}\n`);
};

export default function (pi: any) {
  // confirm: carries a 90 s timeout, so the block shows the countdown.
  pi.registerCommand('hitl-confirm', {
    description: 'Ask a yes/no question with a timeout (pi-kit test)',
    handler: async (args: string, ctx: any) => {
      const ok = await ctx.ui.confirm('Publish the release?', args || 'Tag v2.0.0 and push it.', { timeout: 90_000 });
      record('confirm', ok);
      ctx.ui.notify(`hitl confirm: ${ok}`, 'info');
    },
  });
  // The same question with a timeout that runs out while the block is on screen (the block answers "cancelled" for the user).
  pi.registerCommand('hitl-confirm-short', {
    description: 'Ask a yes/no question that times out after 4 seconds (pi-kit test)',
    handler: async (_args: string, ctx: any) => {
      const ok = await ctx.ui.confirm('Still there?', 'This question gives up after four seconds.', { timeout: 4_000 });
      record('confirm-short', ok);
      ctx.ui.notify(`hitl confirm-short: ${ok}`, 'info');
    },
  });
  pi.registerCommand('hitl-select', {
    description: 'Pick one of three deploy targets (pi-kit test)',
    handler: async (_args: string, ctx: any) => {
      const target = await ctx.ui.select('Pick a deploy target', ['staging', 'production', 'canary']);
      record('select', target);
      ctx.ui.notify(`hitl select: ${target ?? 'nothing'}`, 'info');
    },
  });
  pi.registerCommand('hitl-input', {
    description: 'Ask for a release name (pi-kit test)',
    handler: async (_args: string, ctx: any) => {
      const name = await ctx.ui.input('Release name?', 'e.g. v2.1.0');
      record('input', name);
      ctx.ui.notify(`hitl input: ${name ?? 'nothing'}`, 'info');
    },
  });
  pi.registerCommand('hitl-editor', {
    description: 'Edit the release notes in a multiline editor (pi-kit test)',
    handler: async (_args: string, ctx: any) => {
      const text = await ctx.ui.editor('Edit the release notes', '# Release notes\n\n- first change\n');
      record('editor', text);
      ctx.ui.notify(`hitl editor: ${text === undefined ? 'nothing' : `${text.length} characters`}`, 'info');
    },
  });
  // A guard on the bash tool: the dialog opens while the tool call runs, so the block names the tool.
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (event.toolName === 'bash' && /touch hitl-guarded/.test(String(event.input?.command))) {
      const ok = await ctx.ui.confirm(`Run ${event.input.command}?`, 'The hitl guard wants a yes before it lets this through.');
      record('guard', ok);
      if (!ok) return { block: true, reason: 'Denied by the user in pi-kit' };
    }
  });
}
