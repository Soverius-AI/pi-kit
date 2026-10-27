import { english } from '@pi-kit/i18n/testing';
import { describe, expect, it } from 'vitest';
import { agoText, outcomeSummary, outcomeTitle, scoreLine, shortHead } from './outcome';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const head = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('outcomeTitle: the badge tooltip', () => {
  it('names the base branch, the short commit and when, for a merge', () => {
    expect(outcomeTitle(english, { kind: 'merged', head, at: NOW - 2 * 3_600_000 }, 'main', NOW)).toBe(
      'Merged into main as a1b2c3d, 2 h ago',
    );
  });

  it('says "the base branch" for a merge whose branch is not known', () => {
    expect(outcomeTitle(english, { kind: 'merged', head, at: NOW }, null, NOW)).toBe(
      'Merged into the base branch as a1b2c3d, just now',
    );
  });

  it('says committed and pull request in their own words', () => {
    expect(outcomeTitle(english, { kind: 'committed', head, at: NOW - 12 * 60_000 }, 'main', NOW)).toBe(
      'Committed as a1b2c3d, 12 min ago',
    );
    expect(
      outcomeTitle(
        english,
        { kind: 'pr', head, at: NOW - 3 * 86_400_000, url: 'https://example.test/pr/1' },
        'main',
        NOW,
      ),
    ).toBe('Pull request opened for a1b2c3d, 3 d ago');
  });

  it('adds the score as a second line when the thread was scored, and nothing when it was not', () => {
    const line = '62 % steered: 14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand';
    expect(
      outcomeTitle(
        english,
        { kind: 'committed', head, at: NOW, score: { meat: 62, vibe: 38, line, stale: false } },
        'main',
        NOW,
      ),
    ).toBe(`Committed as a1b2c3d, just now\n${line}`);
    expect(
      outcomeTitle(
        english,
        { kind: 'committed', head, at: NOW, score: { meat: null, vibe: null, line: null, stale: false } },
        'main',
        NOW,
      ),
    ).toBe('Committed as a1b2c3d, just now');
    expect(
      scoreLine(english, { kind: 'committed', head, at: NOW, score: { meat: 62, vibe: 38, line, stale: true } }),
    ).toBe(`${line} (the outcome has changed since; score it again)`);
    expect(scoreLine(english, { kind: 'committed', head, at: NOW })).toBe('');
  });

  it('summarises the outcome for the review header', () => {
    expect(outcomeSummary(english, { kind: 'merged', head, at: 1 })).toBe('merged as a1b2c3d');
    expect(outcomeSummary(english, { kind: 'committed', head, at: 1 })).toBe('committed as a1b2c3d');
    expect(outcomeSummary(english, { kind: 'pr', head, at: 1 })).toBe('a pull request at a1b2c3d');
  });
});

describe('agoText', () => {
  it('steps from just now to minutes, hours, days and a date', () => {
    expect(agoText(english, NOW - 30_000, NOW)).toBe('just now');
    expect(agoText(english, NOW - 59 * 60_000, NOW)).toBe('59 min ago');
    expect(agoText(english, NOW - 5 * 3_600_000, NOW)).toBe('5 h ago');
    expect(agoText(english, NOW - 29 * 86_400_000, NOW)).toBe('29 d ago');
    expect(agoText(english, NOW - 60 * 86_400_000, NOW)).toMatch(/^on /);
    // A clock that is a little behind never shows a negative time.
    expect(agoText(english, NOW + 5000, NOW)).toBe('just now');
  });

  it('shortens a commit to seven characters', () => {
    expect(shortHead(head)).toBe('a1b2c3d');
    expect(shortHead('abc')).toBe('abc');
  });
});
