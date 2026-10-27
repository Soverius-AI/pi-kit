// pi-kit test extension: a confirm dialog, a select, an input, notify, status and a widget, argument completion,
// a toolbar action and a suggestion over the shared event bus.
const FRUITS = ['apple', 'apricot', 'banana', 'blueberry'];


export default function (pi: any) {
  pi.registerCommand('pk-colour-status', {
    description: 'Set a colored extension status (pi-kit test)',
    handler: async (_args: string, ctx: any) => {
      ctx.ui.setStatus('speed', '\u001b[38;5;102m87.2 tok/s\u001b[39m');
    },
  });
  pi.registerCommand('pk-confirm', {
    description: 'Ask a yes/no question (pi-kit test)',
    handler: async (args: string, ctx: any) => {
      const ok = await ctx.ui.confirm('Proceed with the test?', args || 'No details given.');
      ctx.ui.notify(ok ? 'Confirmed by the user' : 'Denied by the user', ok ? 'info' : 'warning');
      ctx.ui.setStatus('pk-test', ok ? 'last answer: yes' : 'last answer: no');
    },
  });
  pi.registerCommand('pk-select', {
    description: 'Pick one of three options (pi-kit test)',
    handler: async (_args: string, ctx: any) => {
      const choice = await ctx.ui.select('Which flavour?', ['vanilla', 'chocolate', 'pistachio']);
      ctx.ui.notify(`You picked ${choice ?? 'nothing'}`, 'info');
    },
  });
  pi.registerCommand('pk-input', {
    description: 'Ask for a line of text (pi-kit test)',
    handler: async (_args: string, ctx: any) => {
      const text = await ctx.ui.input('Your name?', 'type here');
      ctx.ui.notify(`Hello ${text ?? 'stranger'}`, 'info');
    },
  });
  pi.registerCommand('pk-fruit', {
    description: 'Pick a fruit (pi-kit test)',
    handler: async (args: string, ctx: any) => {
      ctx.ui.notify(`Fruit: ${args}`, 'info');
    },
  });
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (event.toolName === 'bash' && /touch pk-guarded/.test(String(event.input?.command))) {
      const ok = await ctx.ui.confirm(`Run ${event.input.command}?`, 'Asked by the pk-test extension');
      if (!ok) return { block: true, reason: 'Denied by the user in pi-kit' };
    }
  });
  pi.on('session_start', async (_e: any, ctx: any) => {
    ctx.ui.setWidget('pk-widget', ['pk-test extension loaded']);
    // Completes the argument of /pk-fruit and leaves everything else to the provider below it.
    ctx.ui.addAutocompleteProvider((current: any) => ({
      ...current,
      async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: any) {
        const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
        const match = /^\/pk-fruit (\S*)$/.exec(before);
        if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        const items = FRUITS.filter((fruit) => fruit.startsWith(match[1])).map((fruit) => ({ value: fruit, label: fruit, description: 'fruit' }));
        return items.length > 0 ? { items, prefix: match[1] } : null;
      },
    }));
    // A toolbar button and a suggestion pill in the composer, over pi's shared event bus.
    pi.events.emit('pi-kit:composer', { op: 'action', id: 'pk-hello', label: 'Say hello', icon: 'Hi', text: '/pk-fruit ' });
    pi.events.emit('pi-kit:composer', { op: 'suggestion', id: 'pk-suggest', title: 'Ask for a fruit', text: '/pk-fruit apple', send: false });
  });
}
