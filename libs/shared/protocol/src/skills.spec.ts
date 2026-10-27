import { describe, expect, it } from 'vitest';
import { SkillsEntrySchema, skillChipsOf } from './skills';

describe('skillChipsOf', () => {
  it('reads forwardedProps.skills in order, each skill or template once', () => {
    const chips = skillChipsOf({ skills: [{ kind: 'skill', name: 'a', pinned: true }, { kind: 'prompt', name: 'a' }, { kind: 'skill', name: 'a', pinned: false }, { kind: 'skill', name: 'b', scope: 'project' }] });
    expect(chips).toEqual([
      { kind: 'skill', name: 'a', pinned: true },
      { kind: 'prompt', name: 'a', pinned: false },
      { kind: 'skill', name: 'b', pinned: false, scope: 'project' },
    ]);
  });

  it('ignores anything that is not a list of chips, so the prompt still runs', () => {
    expect(skillChipsOf(undefined)).toEqual([]);
    expect(skillChipsOf({})).toEqual([]);
    expect(skillChipsOf({ skills: [] })).toEqual([]);
    expect(skillChipsOf({ skills: 'alpha' })).toEqual([]);
    expect(skillChipsOf({ skills: [{ kind: 'extension', name: 'x' }] })).toEqual([]);
    expect(skillChipsOf({ skills: [{ kind: 'skill', name: '' }] })).toEqual([]);
    expect(skillChipsOf({ skills: Array.from({ length: 13 }, (_, i) => ({ kind: 'skill', name: `s${i}` })) })).toEqual([]);
  });
});

describe('SkillsEntrySchema', () => {
  it('holds the chips and the sentence', () => {
    expect(SkillsEntrySchema.safeParse({ chips: [{ kind: 'skill', name: 'a' }], text: '' }).success).toBe(true);
    expect(SkillsEntrySchema.safeParse({ chips: [], text: 'x' }).success).toBe(false);
  });
});
