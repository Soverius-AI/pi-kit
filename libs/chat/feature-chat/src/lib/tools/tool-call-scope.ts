import { Directive, input } from '@angular/core';

/**
 * Tells the tool-call renderer below it which call it draws. CopilotKit's `RenderToolCalls` hands a renderer the parsed call
 * (name, arguments, status, result) but not its id, and ours need the id to find the call's `pi.tool`, `pi.bash` and `pi.diff`
 * activities. The wrapper around `copilot-chat-tool-calls-view` draws one view per call and puts this directive on its
 * element; `ToolRowBase` finds it through the element injector.
 */
@Directive({ selector: '[pkToolCall]', host: { class: 'contents' } })
export class PkToolCall {
  readonly callId = input.required<string>({ alias: 'pkToolCall' });
}
