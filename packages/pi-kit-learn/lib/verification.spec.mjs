import { describe, expect, it } from 'vitest';
import { describeVerification } from './verification.mjs';

const done = (result, extra = {}) => ({ state: 'done', result, summary: 'Reproduced 5 of 6 files and 14 of 18 hunks; 1 of 1 check passes again.', ...extra });

describe('describeVerification', () => {
  it('says pass in plain words, with the numbers, and what to do next', () => {
    expect(describeVerification(done('pass'), 'add-notes')).toEqual({
      text: 'add-notes: pass. Reproduced 5 of 6 files and 14 of 18 hunks; 1 of 1 check passes again. Read the report in the review dialog, then approve or discard the draft.',
      level: 'info',
    });
  });

  it('warns on partial, and on failed suggests editing', () => {
    expect(describeVerification(done('partial'), 'add-notes')).toMatchObject({ level: 'warning', text: expect.stringContaining('add-notes: partial.') });
    const failed = describeVerification(done('failed'), 'add-notes');
    expect(failed.level).toBe('warning');
    expect(failed.text).toContain('Edit the skill and verify again, or discard it.');
  });

  it('appends the warnings a report carries', () => {
    expect(describeVerification(done('pass', { warnings: ['The base commit was estimated.'] }), 'x').text).toMatch(/The base commit was estimated\.$/);
  });

  it('a verification that could not be carried out is an error with the reason', () => {
    expect(describeVerification({ state: 'error', error: 'The project is not trusted.' }, 'x')).toEqual({ text: 'x could not be verified: The project is not trusted.', level: 'error' });
  });

  it('stopped, running, never run', () => {
    expect(describeVerification({ state: 'stopped' }, 'x')).toMatchObject({ level: 'info', text: expect.stringContaining('stopped') });
    expect(describeVerification({ state: 'running' }, 'x').text).toContain('Verify: x');
    expect(describeVerification(null, 'x').text).toContain('/learn verify');
    expect(describeVerification({ state: 'not-run' }, 'x').text).toBe('x has not been verified.');
  });
});
