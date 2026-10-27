import { describe, expect, it } from 'vitest';
import { cancelJob, createJob, finishStep, nextStep, planSteps, rowStates, startStep, toJob } from './update-job';

describe('planSteps', () => {
  it('runs pi and packages as one `pi update --all` when a managed install exists, models after, the app last', () => {
    const steps = planSteps(['app', 'models', 'packages', 'pi'], { managed: true });
    expect(steps.map((s) => [s.kind, s.targets])).toEqual([
      ['pi-all', ['pi', 'packages']],
      ['models', ['models']],
      ['app', ['app']],
    ]);
  });

  it('bootstraps the managed install first when there is none, then updates the packages with it', () => {
    expect(planSteps(['pi', 'packages'], { managed: false }).map((s) => s.kind)).toEqual(['bootstrap-pi', 'packages']);
    expect(planSteps(['pi'], { managed: false }).map((s) => s.kind)).toEqual(['bootstrap-pi']);
    expect(planSteps(['pi'], { managed: true }).map((s) => s.kind)).toEqual(['pi-self']);
    expect(planSteps(['packages'], { managed: true }).map((s) => s.kind)).toEqual(['packages']);
  });
});

describe('the job state machine', () => {
  const run = (managed = true) => createJob('j1', ['pi', 'packages', 'models'], 1000, { managed });

  it('goes running → done when every step finishes, and says which rows are running meanwhile', () => {
    let job = run();
    expect(job.state).toBe('running');
    expect(nextStep(job)).toBe(0);
    job = startStep(job, 0);
    expect(rowStates(job)).toEqual({ pi: 'running', packages: 'running' });
    expect(nextStep(job)).toBe(1);
    job = finishStep(job, 0, { ok: true, detail: 'pi 1.3.0 installed' }, 2000);
    expect(rowStates(job)).toEqual({ pi: 'done', packages: 'done' });
    expect(job.state).toBe('running');
    job = finishStep(startStep(job, 1), 1, { ok: true }, 3000);
    expect(job).toMatchObject({ state: 'done', finishedAt: 3000 });
    expect(nextStep(job)).toBe(-1);
  });

  it('a failed step is reported and the remaining steps still run; the job ends failed', () => {
    let job = run();
    job = finishStep(startStep(job, 0), 0, { ok: false, error: 'npm ci exited with code 1' }, 2000);
    expect(job.state).toBe('running');
    expect(rowStates(job)).toEqual({ pi: 'failed', packages: 'failed' });
    expect(nextStep(job)).toBe(1);
    job = finishStep(startStep(job, 1), 1, { ok: true }, 3000);
    expect(job).toMatchObject({ state: 'failed', finishedAt: 3000 });
    expect(job.steps[0]).toMatchObject({ state: 'failed', error: 'npm ci exited with code 1' });
  });

  it('cancel stops the running step and everything after it; a finished step keeps its result', () => {
    let job = run();
    job = finishStep(startStep(job, 0), 0, { ok: true }, 2000);
    job = startStep(job, 1);
    job = cancelJob(job, 2500);
    expect(job).toMatchObject({ state: 'cancelled', finishedAt: 2500 });
    expect(job.steps.map((s) => s.state)).toEqual(['done', 'cancelled']);
    expect(nextStep(job)).toBe(-1);
    // a late answer from the step that was killed does not revive the job
    const late = finishStep(job, 1, { ok: false, error: 'Cancelled.', cancelled: true }, 2600);
    expect(late.state).toBe('cancelled');
  });

  it('cancelling a job that ended is a no-op', () => {
    let job = createJob('j2', ['models'], 0, { managed: true });
    job = finishStep(startStep(job, 0), 0, { ok: true }, 1);
    expect(cancelJob(job, 2)).toBe(job);
  });

  it('a step that reports cancelled while the job still runs ends as cancelled, not failed', () => {
    let job = createJob('j3', ['models'], 0, { managed: true });
    job = finishStep(startStep(job, 0), 0, { ok: false, error: 'Cancelled.', cancelled: true }, 1);
    expect(job.steps[0].state).toBe('cancelled');
    expect(job.state).toBe('done');
  });

  it('maps to the protocol job', () => {
    const job = run();
    expect(toJob(job, '/logs/update.log')).toEqual({ id: 'j1', targets: ['pi', 'packages', 'models'], state: 'running', startedAt: 1000, logPath: '/logs/update.log' });
  });
});
