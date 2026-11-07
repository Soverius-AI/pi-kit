/* global crypto, fetch, TextDecoder, AbortSignal */
// Evaluate in an ALREADY PAIRED browser on the test gateway origin, then call:
// headlessModelTest.start(threadId, prompt, optionalTestCwd)
// headlessModelTest.summary()
// The model runs in the real Docker backend; this is not a mock or direct model call.
// Provider configuration and input fixtures must already exist in the test profile.

globalThis.headlessModelTest = {
  result: undefined,
  start(threadId, prompt, cwd = '/home/tester/headless-test-project') {
    if (
      cwd !== '/home/tester/headless-test-project' &&
      !/^\/Users\/[^/]+\/Library\/Caches\/pi-kit-macos-service-test-[^/]+\/home\/project$/.test(cwd)
    )
      throw new Error('Only a disposable integration-test project is allowed.');
    if (this.result?.status === 'streaming' || this.result?.status === 'starting')
      throw new Error('A test is already running.');
    const result = { threadId, status: 'starting', events: [], text: '', startedAt: Date.now() };
    this.result = result;
    void (async () => {
      try {
        const session = await fetch('/phone/session');
        if (!session.ok) throw new Error(`Browser is not paired (${session.status}).`);
        const { token } = await session.json(); // Device CSRF token, never printed or persisted.
        const input = {
          threadId,
          runId: crypto.randomUUID(),
          state: {},
          messages: [{ id: crypto.randomUUID(), role: 'user', content: prompt }],
          tools: [],
          context: [],
          forwardedProps: { cwd },
        };
        const response = await fetch('/api/copilotkit/agent/pi/run', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(240_000),
        });
        result.httpStatus = response.status;
        if (!response.ok) throw new Error(await response.text());
        result.status = 'streaming';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            const event = JSON.parse(payload);
            result.events.push(event);
            if (event.type === 'TEXT_MESSAGE_CONTENT') result.text += event.delta ?? '';
            if (event.type === 'RUN_ERROR') result.error = event.message;
          }
        }
        const finished = result.events.findLast((event) => event.type === 'RUN_FINISHED');
        if (!finished) throw new Error('Stream ended without RUN_FINISHED.');
        if (finished.outcome?.type !== 'success') throw new Error(`Run outcome: ${finished.outcome?.type}`);
        result.status = result.error ? 'failed' : 'complete';
      } catch (error) {
        result.status = 'failed';
        result.error = String(error);
      } finally {
        result.elapsedMs = Date.now() - result.startedAt;
      }
    })();
    return { started: true, threadId };
  },
  summary() {
    const result = this.result;
    if (!result) return { status: 'not-started' };
    const snapshot = result.events.findLast((event) => event.type === 'MESSAGES_SNAPSHOT');
    return {
      status: result.status,
      httpStatus: result.httpStatus,
      elapsedMs: result.elapsedMs,
      error: result.error,
      events: result.events.length,
      toolCalls: result.events.filter((event) => event.type === 'TOOL_CALL_START').map((event) => event.toolCallName),
      outcome: result.events.findLast((event) => event.type === 'RUN_FINISHED')?.outcome,
      turns: snapshot?.messages
        .filter((message) => message.activityType === 'pi.turn_usage')
        .map((message) => message.content),
      reply: result.text,
    };
  },
};
