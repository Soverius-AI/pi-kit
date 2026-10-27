import type { AbstractAgent, BaseEvent, RunAgentInput } from '@ag-ui/client';
import type { Observable } from 'rxjs';

/**
 * `agent.run(input)` with the middleware the runtime attached to the agent (`agent.use(...)`): CopilotKit's A2UI
 * middleware, which turns a click on a surface (`forwardedProps.a2uiAction`) into the message pair `PiAgent` reads,
 * and Open Generative UI middleware, which turns generateSandboxedUi arguments into streamed UI activities.
 *
 * The runtime's own runner calls `agent.runAgent()`, which applies the middleware and then also feeds every event
 * into the client-side message state (verification, subscribers, `agent.messages`). Our runner owns the log and the
 * replay and wants the raw event stream, so it only needs the middleware part. `AbstractAgent` keeps the
 * list private; this chains it the way `runAgent()` does (last registered runs closest to the agent). If a future
 * version stops exposing the list the run goes through unwrapped, losing action conversion and incremental UI
 * rendering; completed interfaces still come from pi's stored tool results. Tests pin the middleware chain.
 */
export function runWithMiddleware(agent: AbstractAgent, input: RunAgentInput): Observable<BaseEvent> {
  const middlewares = (agent as unknown as { middlewares?: { run(input: RunAgentInput, next: unknown): Observable<BaseEvent> }[] }).middlewares;
  if (!Array.isArray(middlewares) || middlewares.length === 0) return agent.run(input);
  const chain = middlewares.reduceRight<{ run(input: RunAgentInput): Observable<BaseEvent>; messages: unknown; state: unknown }>(
    (next, middleware) => ({
      run: (i) => middleware.run(i, next),
      get messages() {
        return next.messages;
      },
      get state() {
        return next.state;
      },
    }),
    agent as never,
  );
  return chain.run(input);
}
