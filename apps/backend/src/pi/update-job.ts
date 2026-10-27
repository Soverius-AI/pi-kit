import type { UpdateJob, UpdateRowState, UpdateTarget } from '@pi-kit/protocol';

/**
 * The state machine of one update job. It knows nothing about processes: `planSteps` turns the requested targets
 * into an ordered list of steps, the runner starts and finishes them, and this module says what every row and the job as a whole are
 * at each moment, so it runs under plain unit tests.
 *
 *   pi + packages  -> `pi update --all` (one step, two rows)      or, with no managed install: bootstrap pi, then `pi update --extensions`
 *   pi             -> `pi update`                                 or bootstrap
 *   packages       -> `pi update --extensions`
 *   models         -> `pi update --models`   (pi refuses `--models` together with `--all`)
 *   app            -> pi-kit's own update through the desktop shell, last
 *
 * A failed step does not stop the others (they are independent); a cancel stops everything that has not finished.
 */

export type StepKind = 'bootstrap-pi' | 'pi-all' | 'pi-self' | 'packages' | 'models' | 'app';
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Step {
  kind: StepKind;
  /** The rows this step drives. */
  targets: UpdateTarget[];
  state: StepState;
  error?: string;
  /** What the step reports when it finishes (`pi 1.3.0 installed`). */
  detail?: string;
}

export interface Job {
  id: string;
  targets: UpdateTarget[];
  state: UpdateJob['state'];
  startedAt: number;
  finishedAt?: number;
  steps: Step[];
}

export function planSteps(targets: readonly UpdateTarget[], options: { managed: boolean }): Step[] {
  const want = new Set(targets);
  const steps: Step[] = [];
  const add = (kind: StepKind, rows: UpdateTarget[]): void => void steps.push({ kind, targets: rows, state: 'pending' });
  if (want.has('pi') && want.has('packages')) {
    if (options.managed) add('pi-all', ['pi', 'packages']);
    else {
      add('bootstrap-pi', ['pi']);
      add('packages', ['packages']);
    }
  } else if (want.has('pi')) add(options.managed ? 'pi-self' : 'bootstrap-pi', ['pi']);
  else if (want.has('packages')) add('packages', ['packages']);
  if (want.has('models')) add('models', ['models']);
  if (want.has('app')) add('app', ['app']);
  return steps;
}

export function createJob(id: string, targets: readonly UpdateTarget[], now: number, options: { managed: boolean }): Job {
  return { id, targets: [...targets], state: 'running', startedAt: now, steps: planSteps(targets, options) };
}

/** The index of the next step to run, or `-1` when none is left (or the job was cancelled). */
export function nextStep(job: Job): number {
  if (job.state !== 'running') return -1;
  return job.steps.findIndex((step) => step.state === 'pending');
}

export function startStep(job: Job, index: number): Job {
  return withStep(job, index, (step) => ({ ...step, state: 'running' }));
}

export function finishStep(job: Job, index: number, result: { ok: true; detail?: string } | { ok: false; error: string; cancelled?: boolean }, now: number): Job {
  const next = withStep(job, index, (step) =>
    result.ok
      ? { ...step, state: 'done', ...(result.detail ? { detail: result.detail } : {}) }
      : { ...step, state: result.cancelled ? 'cancelled' : 'failed', error: result.error },
  );
  return settle(next, now);
}

/** Cancels the running step and everything after it. A job that already ended stays as it was. */
export function cancelJob(job: Job, now: number): Job {
  if (job.state !== 'running') return job;
  return { ...job, state: 'cancelled', finishedAt: now, steps: job.steps.map((step) => (step.state === 'pending' || step.state === 'running' ? { ...step, state: 'cancelled' as const } : step)) };
}

/** The job as a whole once no step is pending or running: failed if any step failed, else done. */
function settle(job: Job, now: number): Job {
  if (job.state !== 'running' || job.steps.some((step) => step.state === 'pending' || step.state === 'running')) return job;
  return { ...job, state: job.steps.some((step) => step.state === 'failed') ? 'failed' : 'done', finishedAt: now };
}

function withStep(job: Job, index: number, change: (step: Step) => Step): Job {
  return { ...job, steps: job.steps.map((step, i) => (i === index ? change(step) : step)) };
}

/** What each target the job drives is at the moment: `undefined` for rows it does not touch or has not reached. */
export function rowStates(job: Job): Partial<Record<UpdateTarget, UpdateRowState>> {
  const out: Partial<Record<UpdateTarget, UpdateRowState>> = {};
  for (const step of job.steps) {
    const state: UpdateRowState | undefined =
      step.state === 'running' ? 'running' : step.state === 'done' ? 'done' : step.state === 'failed' ? 'failed' : step.state === 'cancelled' ? 'cancelled' : undefined;
    if (state) for (const target of step.targets) out[target] = state;
  }
  return out;
}

export function toJob(job: Job, logPath?: string): UpdateJob {
  return { id: job.id, targets: job.targets, state: job.state, startedAt: job.startedAt, ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}), ...(logPath ? { logPath } : {}) };
}
