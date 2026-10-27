import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandsService } from './commands.service';
import { parsePromptSuggestion, PromptSuggestionReader, readFrontmatter } from './prompt-suggestion';

describe('readFrontmatter', () => {
  it('reads flat pairs between the two --- lines and drops quotes', () => {
    expect(readFrontmatter('---\ndescription: "Review it"\nsuggested: true\nsuggestion-title: \'My title\'\n---\nBody\n')).toEqual({
      description: 'Review it',
      suggested: 'true',
      'suggestion-title': 'My title',
    });
  });

  it('copes with CRLF line ends and a byte order mark', () => {
    expect(readFrontmatter('﻿---\r\nsuggested: true\r\n---\r\nBody')).toEqual({ suggested: 'true' });
  });

  it('is undefined without frontmatter or with an unclosed block', () => {
    expect(readFrontmatter('Just a body\n---\nsuggested: true\n---\n')).toBeUndefined();
    expect(readFrontmatter('---\nsuggested: true\nno end')).toBeUndefined();
  });

  it('ignores comments and lines that are not pairs', () => {
    expect(readFrontmatter('---\n# note\nsuggested: true\n  - item\n---\n')).toEqual({ suggested: 'true' });
  });
});

describe('parsePromptSuggestion', () => {
  it('is suggested only with suggested: true', () => {
    expect(parsePromptSuggestion('---\nsuggested: true\n---\nx')).toEqual({ suggested: true });
    expect(parsePromptSuggestion('---\nsuggested: false\n---\nx')).toBeUndefined();
    expect(parsePromptSuggestion('---\ndescription: x\n---\nx')).toBeUndefined();
    expect(parsePromptSuggestion('no frontmatter')).toBeUndefined();
  });

  it('carries the suggestion title', () => {
    expect(parsePromptSuggestion('---\nsuggested: true\nsuggestion-title: Review my changes\n---\nx')).toEqual({
      suggested: true,
      suggestionTitle: 'Review my changes',
    });
  });
});

describe('PromptSuggestionReader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pk-prompt-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a template file and notices when it changes', () => {
    const file = join(dir, 'review.md');
    writeFileSync(file, '---\nsuggested: true\n---\nReview');
    const reader = new PromptSuggestionReader();
    expect(reader.read(file)).toEqual({ suggested: true });
    writeFileSync(file, '---\ndescription: x\n---\nReview, longer now');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(reader.read(file)).toBeUndefined();
  });

  it('answers from the cache while the file is unchanged', () => {
    const file = join(dir, 'review.md');
    writeFileSync(file, '---\nsuggested: true\n---\nReview');
    const reader = new PromptSuggestionReader();
    reader.read(file);
    const fresh = reader.read(file);
    expect(fresh).toEqual({ suggested: true });
  });

  it('gives nothing for a file that is not there', () => {
    expect(new PromptSuggestionReader().read(join(dir, 'missing.md'))).toBeUndefined();
  });
});

describe('CommandsService.merge with suggestions', () => {
  const service = new CommandsService(undefined as never, undefined as never);

  it('adds suggested and suggestionTitle to prompt templates only, and nothing else changes', () => {
    const read = (path: string) => (path === '/p/review.md' ? { suggested: true as const, suggestionTitle: 'Review my changes' } : undefined);
    const commands = service.merge(
      [
        { name: 'review', description: 'Review', source: 'prompt', scope: 'project', origin: 'project', path: '/p/review.md' },
        { name: 'plain', description: 'Plain', source: 'prompt', scope: 'project', origin: 'project', path: '/p/plain.md' },
        { name: 'skill:x', description: 'Skill', source: 'skill', scope: 'user', origin: 'user', path: '/p/review.md' },
      ],
      read,
    );
    expect(commands[0]).toEqual({ name: 'review', description: 'Review', source: 'prompt', kind: 'prompt', origin: 'project', suggested: true, suggestionTitle: 'Review my changes' });
    expect(commands[1]).toEqual({ name: 'plain', description: 'Plain', source: 'prompt', kind: 'prompt', origin: 'project' });
    expect(commands[2]).not.toHaveProperty('suggested');
  });
});
