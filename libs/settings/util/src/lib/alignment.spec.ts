import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { alignmentProblems, controlWidthProblems, ctlColumnProblems } from './alignment';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Files that are not under the rule yet (none now: every settings template is held to it). */
const NOT_YET: RegExp[] = [];

function templates(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : templates(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('the control column rule', () => {
  it('finds a control with a width of its own, however the tag is written', () => {
    const source = [
      '<div class="ctl ctl-w">',
      '  <select class="select select-sm w-44" (change)="a(b > c)">',
      '  <input',
      '    class="input w-[22rem] mono" />',
    ].join('\n');
    expect(controlWidthProblems(source).map((p) => [p.line, p.rule])).toEqual([
      [2, 'control-width'],
      [3, 'control-width'],
    ]);
  });

  it('leaves alone widths that fill, spans and the min and max widths of a flex row', () => {
    const source =
      '<input class="input w-full"><select class="select flex-1 min-w-48 max-w-full"><span class="w-2 h-2 rounded-full"></span><div class="w-80"></div><button class="btn btn-sm">w-36</button>';
    expect(controlWidthProblems(source)).toEqual([]);
  });

  it('wants every control column to be ctl ctl-w', () => {
    const source = [
      '<div class="ctl">',
      '<div class="ctl wrap">',
      '<div class="ctl ctl-w">',
      '<div class="ctl ctl-w wrap">',
      '<div class="control">',
    ].join('\n');
    expect(ctlColumnProblems(source).map((p) => p.line)).toEqual([1, 2]);
  });

  it('holds every settings template to it', () => {
    // The section libraries are the settings pages; `settings/api` holds the onboarding cards (their own layout) and the dialogs of the key workflow.
    const libs = join(root, 'libs', 'settings');
    const sections = readdirSync(libs).filter((name) => name.startsWith('feature-'));
    expect(sections.length).toBeGreaterThanOrEqual(7);
    const found = sections
      .flatMap((name) => templates(join(libs, name)))
      .map((file) => relative(root, file))
      .filter((file) => !NOT_YET.some((pattern) => pattern.test(file)))
      .flatMap((file) =>
        alignmentProblems(readFileSync(join(root, file), 'utf8')).map((p) => `${file}:${p.line} ${p.rule}: ${p.text}`),
      );
    expect(
      found,
      `Settings controls must sit in the control column (ctl ctl-w) and carry no width of their own:\n${found.join('\n')}`,
    ).toEqual([]);
  });
});
