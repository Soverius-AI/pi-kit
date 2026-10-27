import { english } from '@pi-kit/i18n/testing';
import { entryText } from './graph.store';

describe('entryText (the Entries inspector)', () => {
  it('names the prompt sections a system message sets and removes', () => {
    const text = entryText(english, {
      type: 'message',
      message: { role: 'system', content: '', sections: { preamble: 'x', tools: 'y', skills: null } },
    });
    expect(text).toBe('sections preamble, tools, -skills');
  });

  it('shows the "other agents" section in words, without its tag', () => {
    const body =
      '<other_agents>\nOther agents in this workspace\n- "Fix e2e" (idle, this same folder): edited src/map.ts (1 min ago).\n</other_agents>';
    const text = entryText(english, {
      type: 'message',
      message: { role: 'system', content: '', sections: { other_agents: body } },
    });
    expect(text).toBe(
      'sections other_agents: Other agents in this workspace - "Fix e2e" (idle, this same folder): edited src/map.ts (1 min ago).',
    );
  });

  it('shows what an extension put in front of the model', () => {
    expect(
      entryText(english, {
        type: 'custom_message',
        customType: 'pi-kit:coordination',
        content: '*Fix e2e* changed `src/map.ts` since you last read it.',
        display: true,
      }),
    ).toBe('pi-kit:coordination: *Fix e2e* changed `src/map.ts` since you last read it.');
  });

  it('still says what an ordinary message says', () => {
    expect(
      entryText(english, {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello   there' }] },
      }),
    ).toBe('hello there');
    expect(entryText(english, { type: 'session_info', name: 'Reporting adapter' })).toBe('Reporting adapter');
  });

  it('shows the instructions pi got for a message with skill blocks (more than a plain message keeps), and what a custom entry holds', () => {
    const block = (name: string) =>
      `<skill name="${name}" location="/s/${name}/SKILL.md">\nReferences are relative to /s/${name}.\n\n${'Do the ' + name + ' thing. '.repeat(8)}\n</skill>`;
    const text = entryText(english, {
      type: 'message',
      message: { role: 'user', content: `${block('alpha')}\n\n${block('beta')}\n\ncheck it` },
    });
    expect(text.length).toBeGreaterThan(300);
    expect(text).toContain('<skill name="alpha"');
    expect(text).toContain('<skill name="beta"');
    expect(text).toContain('check it');
    expect(entryText(english, { type: 'message', message: { role: 'user', content: 'x'.repeat(300) } })).toHaveLength(
      120,
    );
    expect(
      entryText(english, {
        type: 'custom',
        customType: 'pi-kit.skills',
        data: { chips: [{ kind: 'skill', name: 'alpha' }], text: 'hi' },
      }),
    ).toBe('pi-kit.skills: {"chips":[{"kind":"skill","name":"alpha"}],"text":"hi"}');
  });
});
