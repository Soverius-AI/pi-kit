import { TestBed } from '@angular/core/testing';
import { PkStepLog, type PkStep } from './step-log';

describe('PkStepLog', () => {
  it('lists each step with its state, opens a failed one and shows its output', async () => {
    const step = (id: string, state: PkStep['state'], output: string | null): PkStep => ({
      id,
      name: id,
      icon: 'terminal',
      tag: 'Tool',
      detail: `gh pr view ${id}`,
      state,
      stateLabel: state,
      output,
      duration: '2s',
    });
    const fixture = TestBed.createComponent(PkStepLog);
    const root = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('emptyOutput', '(no output)');
    fixture.componentRef.setInput('steps', [step('show', 'done', 'PR 7'), step('comment', 'failed', null)]);
    await fixture.whenStable();
    const rows = [...root.querySelectorAll<HTMLDetailsElement>('[data-testid=step]')];
    expect(rows.map((row) => [row.getAttribute('data-state'), row.open])).toEqual([
      ['done', false],
      ['failed', true],
    ]);
    expect(rows[0]?.querySelector('pk-run-status')?.getAttribute('aria-label')).toBe('done');
    expect(rows[0]?.querySelector('[data-testid=step-output]')?.textContent).toBe('PR 7');
    expect(rows[1]?.querySelector('[data-testid=step-output]')?.textContent).toBe('(no output)');
    expect(rows[1]?.querySelector('.command')?.textContent).toBe('gh pr view comment');
  });
});
