import { Component, computed, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/data';
import type { AgentLiveNestedTool, AgentLiveTiming, AgentLiveTool } from '@pi-kit/chat/util';
import { ClockStore } from '@pi-kit/data-access';
import { BashToolRow } from './bash-tool-row';
import { DefaultToolRow } from './default-tool-row';
import { NestedToolCalls } from './nested-tool-calls';
import { PkToolCall } from './tool-call-scope';

@Component({
  imports: [PkToolCall, BashToolRow, DefaultToolRow, NestedToolCalls],
  template: `
    <div class="pk-activity">
      <span [pkToolCall]="callId()">
        @if (name() === 'bash') {
          <pk-bash-tool-row [toolCall]="call()" />
        } @else {
          <pk-default-tool-row [toolCall]="call()" />
        }
      </span>
      <pk-nested-tool-calls [callId]="callId()" />
    </div>
  `,
})
class RowHost {
  readonly callId = input('c1');
  readonly name = input('bash');
  protected readonly call = computed(
    () => ({ name: this.name(), args: { command: 'npm test' }, status: 'executing', result: undefined }) as const,
  );
}

class AgentRows {
  static readonly tools = signal<ReadonlyMap<string, AgentLiveTool>>(new Map());
  static readonly results = signal(new Map<string, { content: string; error?: string }>());
  static readonly nested = signal<ReadonlyMap<string, readonly AgentLiveNestedTool[]>>(new Map());
  static readonly timing = signal<ReadonlyMap<string, AgentLiveTiming>>(new Map());
  static readonly now = signal(100_000);

  static tool(over: Partial<AgentLiveTool> = {}): void {
    const tool: AgentLiveTool = { callId: 'c1', name: 'bash', status: 'running', ...over };
    AgentRows.tools.set(new Map([[tool.callId, tool]]));
  }

  static async render(name = 'bash') {
    const fixture = TestBed.createComponent(RowHost);
    fixture.componentRef.setInput('name', name);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }
}

describe('tool rows of a background agent (no pi.tool or pi.bash activity)', () => {
  beforeEach(() => {
    AgentRows.tools.set(new Map());
    AgentRows.results.set(new Map());
    AgentRows.nested.set(new Map());
    AgentRows.timing.set(new Map());
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ChatStore,
          useValue: {
            activities: signal(new Map()),
            results: AgentRows.results,
            running: signal(false),
            agentLive: () => ({
              messages: [],
              live: undefined,
              tools: AgentRows.tools(),
              nested: AgentRows.nested(),
              timing: AgentRows.timing(),
            }),
            stop: vi.fn(),
          },
        },
        { provide: ApiClient, useValue: {} },
        { provide: ClockStore, useValue: { now: AgentRows.now } },
      ],
    });
  });

  it('takes a bash row state, progress and output tail from the pinned live tool', async () => {
    AgentRows.tool({ status: 'pending' });
    const { fixture, root } = await AgentRows.render();
    expect(root.querySelector('.pk-row')?.getAttribute('data-state')).toBe('running');

    AgentRows.tool({ output: 'PASS a.spec.ts\nRUN b.spec.ts\n\n', droppedLines: 12 });
    AgentRows.timing.set(new Map([['c1', { startedAt: 88_000 }]]));
    await fixture.whenStable();
    expect(root.querySelector('.pk-row .sub')?.textContent).toBe('RUN b.spec.ts, 12s');
    expect(root.querySelector('[data-testid="tool-output"] .meta')?.textContent).toBe('… 12 earlier lines not shown');
    expect(root.querySelector('[data-testid="tool-output"] pre')?.textContent).toContain('PASS a.spec.ts');
    expect(root.querySelector('[data-testid="tool-output"] .animate-pulse')).not.toBeNull();

    AgentRows.tool({ status: 'done', output: 'done' });
    AgentRows.timing.set(new Map([['c1', { startedAt: 88_000, endedAt: 93_000 }]]));
    await fixture.whenStable();
    expect(root.querySelector('.pk-row')?.getAttribute('data-state')).toBe('done');
    expect(root.querySelector('.pk-row .stat')?.textContent?.trim()).toBe('5s');

    AgentRows.results.set(new Map([['c1', { content: 'all passed' }]]));
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="tool-output"]')).toBeNull();
  });

  it('shows a running live tool in an opened default row and is interrupted without one', async () => {
    AgentRows.tool({ name: 'fetch', output: 'GET /api' });
    const { fixture, root } = await AgentRows.render('fetch');
    expect(root.querySelector('.pk-row')?.getAttribute('data-state')).toBe('running');
    expect(root.querySelector('.pk-row .sub')?.textContent).toBe('GET /api');
    root.querySelector<HTMLElement>('.pk-row')!.click();
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="tool-output"] pre')?.textContent).toContain('GET /api');

    AgentRows.tools.set(new Map());
    await fixture.whenStable();
    expect(root.querySelector('.pk-row')?.getAttribute('data-state')).toBe('error');
  });

  it('lists the calls made by a row tool under that row, with status, duration, errors and output on demand', async () => {
    AgentRows.tool({ name: 'agent' });
    AgentRows.nested.set(
      new Map([
        [
          'c1',
          [
            { callId: 'n1', parentCallId: 'c1', name: 'bash', status: 'running', output: 'compiling' },
            {
              callId: 'n2',
              parentCallId: 'c1',
              name: 'read',
              status: 'done',
              summary: { isError: true, error: 'ENOENT' },
            },
          ],
        ],
      ]),
    );
    AgentRows.timing.set(new Map([['n1', { startedAt: 97_000 }]]));
    const { fixture, root } = await AgentRows.render('agent');
    const nested = root.querySelector<HTMLElement>('pk-nested-tool-calls [data-nested]')!;
    const running = nested.querySelector<HTMLElement>('[data-call="n1"] .pk-row')!;
    expect(running.getAttribute('data-state')).toBe('running');
    expect(running.querySelector('.sub')?.textContent).toBe('Running, 3s');
    expect(nested.querySelector('[data-call="n2"] .pk-row')?.getAttribute('data-state')).toBe('error');
    expect(nested.querySelector('[data-call="n2"] .sub')?.textContent).toBe('ENOENT');
    expect(nested.querySelector('[data-testid="tool-output"]')).toBeNull();
    running.click();
    await fixture.whenStable();
    expect(nested.querySelector('[data-testid="tool-output"]')?.textContent).toContain('compiling');
    AgentRows.nested.set(new Map());
    await fixture.whenStable();
    expect(root.querySelector('pk-nested-tool-calls [data-nested]')).toBeNull();
  });
});
