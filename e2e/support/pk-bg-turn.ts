// pi-kit test extension for turns pi starts by itself. createWorld() (e2e/support/env.mjs) copies it to
// <project>/.pi/extensions/pk-bg-turn.ts. Its one command answers at once and, a moment later, when the command's own run is over and the
// thread is idle, starts a turn the way a background agent's report or an extension's timer would: `/pk-turn message <text>` places a custom
// message with `triggerTurn`, `/pk-turn user <text>` a user message. The transcript must show that turn live, without a reload.
export default function (pi: any) {
  pi.registerCommand('pk-turn', {
    description: 'Start a turn from the extension once the thread is idle (pi-kit test)',
    handler: async (args: string) => {
      const [kind, ...rest] = args.trim().split(/\s+/);
      const text = rest.join(' ') || 'The extension has something to say.';
      setTimeout(() => {
        if (kind === 'user') pi.sendUserMessage(text);
        else pi.sendMessage({ customType: 'pk-turn', content: text, display: true }, { triggerTurn: true });
      }, 700);
    },
  });
}
