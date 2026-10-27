/**
 * When the attendant drafts a skill on its own. Pure, so the rule is tested without a thread: a thread that landed an outcome is worth a
 * draft when it did real work (at least `MIN_TOOL_CALLS` tool calls), changed more than a trivial amount (at least `MIN_CHANGED_LINES` lines of the outcome's diff), and no
 * skill that pi already has describes the same kind of task, which is when the first prompt and a skill's description share its key terms.
 */

export const MIN_TOOL_CALLS = 6;
export const MIN_CHANGED_LINES = 10;
/** Key terms of the first prompt a skill's description must share for the skill to count as "already there". */
export const MATCH_TERMS = 3;

/** Words that carry no task: common English and the verbs every prompt starts with. */
const STOP = new Set(
  (
    'the and for with that this from have has had into onto over under when then than them they their there here what which while where will would should could can cannot ' +
    'does did done not but are was were been being use used using make made please just also some any all each every about after before again only more most other such ' +
    'your you our out too very let lets need needs want wants like new add adds added create creates change changes update updates fix fixes file files code thread task ' +
    'then also now next first second one two get gets set sets run runs write writes read reads'
  ).split(' '),
);

const wordsOf = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((word) => !STOP.has(word));

/** The distinct key words of a prompt (at least four letters, no stop words), in order of first use, at most 12. */
export const keyTerms = (text: string): string[] => [...new Set(wordsOf(text))].slice(0, 12);

export interface ExistingSkill {
  name: string;
  description?: string | undefined;
}

/** The skill that already covers this prompt, if any: the first whose name and description share `MATCH_TERMS` of its key terms (fewer when the prompt has fewer). */
export function matchingSkill(firstPrompt: string, skills: readonly ExistingSkill[]): ExistingSkill | undefined {
  const terms = keyTerms(firstPrompt);
  if (terms.length === 0) return undefined;
  const needed = Math.min(MATCH_TERMS, terms.length);
  return skills.find((skill) => {
    const words = new Set(wordsOf(`${skill.name.replace(/-/g, ' ')} ${skill.description ?? ''}`));
    return terms.filter((term) => words.has(term)).length >= needed;
  });
}

export interface DraftFacts {
  toolCalls: number;
  changedLines: number;
  firstPrompt: string;
  skills: readonly ExistingSkill[];
}

export type DraftVerdict = { worth: true } | { worth: false; reason: string };

export function worthADraft(facts: DraftFacts): DraftVerdict {
  if (facts.toolCalls < MIN_TOOL_CALLS) return { worth: false, reason: `Only ${facts.toolCalls} tool calls (a draft needs ${MIN_TOOL_CALLS}).` };
  if (facts.changedLines < MIN_CHANGED_LINES) return { worth: false, reason: `Only ${facts.changedLines} changed lines (a draft needs ${MIN_CHANGED_LINES}).` };
  const covered = matchingSkill(facts.firstPrompt, facts.skills);
  if (covered) return { worth: false, reason: `The skill ${covered.name} already covers this.` };
  return { worth: true };
}
