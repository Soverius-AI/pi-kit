/**
 * The alignment rule of Settings (doc/docs/design-system.md “Alignment”): in a `pk-group` row the control sits in one column of one width (`ctl ctl-w`,
 * `--pk-ctl-w`), selects and inputs fill it, and no control carries a width of its own. These two checks read a template's text and report where the rule is broken, so the
 * rule stays when the next section is written (the unit test runs them over every settings template).
 */

export interface AlignmentProblem {
  /** 1-based line of the template file. */
  line: number;
  rule: 'control-width' | 'ctl-column';
  /** The offending opening tag or attribute, trimmed. */
  text: string;
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length;

/** An opening tag of a control: attribute values may hold `>` (an Angular expression), so quoted values are skipped as a whole. */
const CONTROL_TAG = /<(input|select|textarea|button)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
/** A Tailwind fixed width (`w-36`, `w-[22rem]`), not `w-full`, `min-w-48` or `max-w-full`. */
const FIXED_WIDTH = /(?<![\w-])w-(?:\d|\[)/;

/** Controls (input, select, textarea, button) whose `class` carries a fixed width. */
export function controlWidthProblems(source: string): AlignmentProblem[] {
  const problems: AlignmentProblem[] = [];
  for (const match of source.matchAll(CONTROL_TAG)) {
    const cls = /\bclass="([^"]*)"/.exec(match[2] ?? '')?.[1];
    if (cls !== undefined && FIXED_WIDTH.test(cls))
      problems.push({
        line: lineOf(source, match.index),
        rule: 'control-width',
        text: match[0].replace(/\s+/g, ' ').slice(0, 120),
      });
  }
  return problems;
}

/** A control column (`class="ctl"`) that is not `ctl ctl-w`. */
export function ctlColumnProblems(source: string): AlignmentProblem[] {
  const problems: AlignmentProblem[] = [];
  for (const match of source.matchAll(/\bclass="(ctl(?:\s[^"]*)?)"/g)) {
    if (!/(?<![\w-])ctl-w(?![\w-])/.test(match[1] ?? ''))
      problems.push({ line: lineOf(source, match.index), rule: 'ctl-column', text: match[0] });
  }
  return problems;
}

/** Every problem of a template, in the order of the file. */
export function alignmentProblems(source: string): AlignmentProblem[] {
  return [...controlWidthProblems(source), ...ctlColumnProblems(source)].sort((a, b) => a.line - b.line);
}
