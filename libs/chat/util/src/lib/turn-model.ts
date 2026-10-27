import type { AssistantBlock, BlockUsage, TranscriptBlock } from './transcript-model';

/**
 * Pieces of the transcript: CopilotKit's `CopilotChatMessageView` draws one element per AG-UI message, while the
 * transcript model (`buildTranscript`) groups everything between two user messages into one assistant block. This index maps the
 * blocks back onto messages: for every message the view draws, what the slot templates need to know to make the pieces of one turn
 * read as one turn (spacing, who carries the toolbar and the usage line, how a run of tool calls is stepped and folded).
 * Pure functions, no Angular.
 */

/** More tool calls than this in one list fold the earlier steps behind "N earlier tool calls". */
export const COLLAPSE_ABOVE_CALLS = 6;

export type PieceKind = 'user' | 'think' | 'assistant' | 'genui' | 'usage';

export interface StepPiece {
  /** 1-based number of the step within its assistant block. */
  index: number;
  /** Steps in the block; the "Step 2 of 3" line shows only when this is above 1. */
  of: number;
  calls: number;
  /** Id of the activity list (a run of consecutive steps) the step belongs to. */
  group: string;
  /** The first and the last step of the list. */
  first: boolean;
  last: boolean;
  /** The list is long: the steps before the last one fold behind "N earlier tool calls". */
  folds: boolean;
  /** Tool calls in the steps that fold (on the first step of a folding list). */
  earlierCalls: number;
}

/**
 * The work of a turn as one group (doc/docs/design-system.md "Work group"): every thought, step and interim text of an assistant
 * block before its answer is a row of the group, drawn by the first row's piece as one line ("Ran 7 tool calls") that opens into the rows,
 * each a line of its own that opens into its details. The answer text, generated UI and the usage line stay outside.
 */
export interface WorkPiece {
  /** The group: the assistant block's id. */
  group: string;
  /** 0-based row within the group, and how many rows the group has. */
  row: number;
  rows: number;
  first: boolean;
  last: boolean;
  /** Tool calls, thoughts and steps in the whole group. */
  calls: number;
  thinks: number;
  steps: number;
  /** No answer text came after the work: the turn is still working, or ended on a tool. */
  unanswered: boolean;
}

export interface PieceInfo {
  kind: PieceKind;
  /** The transcript block the piece belongs to: the user message id of a user block, the first message of an assistant block. */
  block: string;
  /** For the pieces of an assistant block: the user message that opened the turn, when there is one (markers and shell blocks end it). */
  after?: string;
  /** The piece is not the first one of its block: it sits 12px under the one above instead of 32. */
  cont: boolean;
  /** The piece continues the activity list of the piece above it (a step after a step), so the list's rule runs through. */
  contActivity: boolean;
  /** The text of the assistant message is the answer the toolbar (copy, regenerate, thumbs) belongs to. */
  toolbar: boolean;
  /** The assistant message has tool calls; this is its step. */
  step?: StepPiece;
  /** The piece is a row of the turn's work group (a block with at least one step). */
  work?: WorkPiece;
}

export interface TurnIndex {
  pieces: ReadonlyMap<string, PieceInfo>;
  /** `pi.turn_usage` activity id → the usage of its whole block, for the last one of each block only (the others draw nothing). */
  usage: ReadonlyMap<string, BlockUsage>;
  /** User message id → its turn number (1-based, along the transcript). */
  turns: ReadonlyMap<string, number>;
  /** Assistant message id with a toolbar → the user message that opened its turn. */
  answers: ReadonlyMap<string, string>;
  /** The last assistant block: the one a running turn adds to (its work group is the one at work). */
  lastBlock: string | undefined;
}

export function indexTurns(blocks: readonly TranscriptBlock[], collapseAboveCalls = COLLAPSE_ABOVE_CALLS): TurnIndex {
  const pieces = new Map<string, PieceInfo>();
  const usage = new Map<string, BlockUsage>();
  const turns = new Map<string, number>();
  const answers = new Map<string, string>();
  let turn = 0;
  let after: string | undefined;
  let lastBlock: string | undefined;

  for (const block of blocks) {
    if (block.kind === 'user') {
      turn += 1;
      after = block.id;
      turns.set(block.id, turn);
      pieces.set(block.id, { kind: 'user', block: block.id, cont: false, contActivity: false, toolbar: false });
      continue;
    }
    if (block.kind !== 'assistant') {
      // A marker or a shell block ends the turn.
      after = undefined;
      continue;
    }
    lastBlock = block.id;
    indexAssistant(block, after, pieces, usage, answers, collapseAboveCalls);
  }
  return { pieces, usage, turns, answers, lastBlock };
}

function indexAssistant(
  block: AssistantBlock,
  after: string | undefined,
  pieces: Map<string, PieceInfo>,
  usage: Map<string, BlockUsage>,
  answers: Map<string, string>,
  collapseAboveCalls: number,
): void {
  const order: string[] = [];
  const add = (id: string, kind: PieceKind): PieceInfo => {
    const existing = pieces.get(id);
    if (existing) return existing;
    const piece: PieceInfo = {
      kind,
      block: block.id,
      ...(after ? { after } : {}),
      cont: order.length > 0,
      contActivity: false,
      toolbar: false,
    };
    pieces.set(id, piece);
    order.push(id);
    return piece;
  };

  let lastText: string | undefined;
  let stepAfterText = false;
  for (const item of block.items) {
    switch (item.kind) {
      case 'think':
        add(item.id, 'think');
        break;
      case 'text':
        add(item.id, 'assistant');
        lastText = item.id;
        stepAfterText = false;
        break;
      case 'genui':
        add(item.id, 'genui');
        break;
      case 'activity': {
        const folds = item.callCount > collapseAboveCalls && item.steps.length > 1;
        const earlierCalls = folds ? item.steps.slice(0, -1).reduce((n, s) => n + s.calls.length, 0) : 0;
        item.steps.forEach((step, i) => {
          const piece = add(step.id, 'assistant');
          // The first step of a list follows whatever the piece above it was; the rest continue the list.
          piece.contActivity = i > 0;
          piece.step = {
            index: step.index,
            of: block.stepCount,
            calls: step.calls.length,
            group: item.id,
            first: i === 0,
            last: i === item.steps.length - 1,
            folds,
            earlierCalls,
          };
        });
        stepAfterText = true;
        break;
      }
    }
  }

  // The toolbar belongs to the last answer text, unless tool calls came after it (then the turn is still working, or ended on a tool).
  if (lastText && !stepAfterText) {
    const piece = pieces.get(lastText);
    if (piece) {
      piece.toolbar = true;
      if (after) answers.set(lastText, after);
    }
  }

  // The work group: everything but the answer, generated UI and usage, once the block has a step at all.
  if (block.stepCount > 0) {
    const answer = lastText && !stepAfterText ? lastText : undefined;
    const rowIds: string[] = [];
    let calls = 0,
      thinks = 0,
      steps = 0;
    for (const item of block.items) {
      if (item.kind === 'genui') continue;
      if (item.kind === 'activity') {
        for (const step of item.steps) {
          if (!rowIds.includes(step.id)) rowIds.push(step.id);
          calls += step.calls.length;
          steps += 1;
        }
        continue;
      }
      if (item.id === answer) continue;
      if (item.kind === 'think') thinks += 1;
      if (!rowIds.includes(item.id)) rowIds.push(item.id);
    }
    rowIds.forEach((id, row) => {
      const piece = pieces.get(id);
      if (piece)
        piece.work = {
          group: block.id,
          row,
          rows: rowIds.length,
          first: row === 0,
          last: row === rowIds.length - 1,
          calls,
          thinks,
          steps,
          unanswered: answer === undefined,
        };
    });
  }

  // The usage line is the last `pi.turn_usage` of the block, after everything else.
  const lastUsage = block.usageIds.at(-1);
  for (const id of block.usageIds) {
    const piece: PieceInfo = {
      kind: 'usage',
      block: block.id,
      ...(after ? { after } : {}),
      cont: order.length > 0,
      contActivity: false,
      toolbar: false,
    };
    pieces.set(id, piece);
    if (id === lastUsage && block.usage) usage.set(id, block.usage);
  }
}
