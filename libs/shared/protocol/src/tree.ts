import { z } from 'zod';
import { QueryFlagSchema } from './query';

/**
 * REST shapes of the session graph: `GET /api/threads/:id/tree` returns rows in
 * display order with the lane assignment already done, so the renderer draws and does no graph work.
 */

export const TreeRowKindSchema = z.enum(['root', 'turn', 'compaction', 'branch_summary', 'label', 'ghost']);
export type TreeRowKind = z.infer<typeof TreeRowKindSchema>;

export const TreeRowSchema = z.object({
  /** The unit's first pi entry id (the user message of a turn); `root` and `ghost` for the two synthetic rows. */
  id: z.string(),
  /** The unit's last pi entry id: where "Go here" moves the leaf. `null` for the synthetic rows. */
  endId: z.string().nullable(),
  /** The first entry id of the row this one continues from (`null` for the root row). */
  parentId: z.string().nullable(),
  kind: TreeRowKindSchema,
  /** Column of the node; 0 is the active path. */
  lane: z.number().int().nonnegative(),
  /** Column of the parent row's node, `null` for the root row. */
  parentLane: z.number().int().nonnegative().nullable(),
  /** Lanes (other than `lane`) whose line crosses this whole row. */
  through: z.array(z.number().int().nonnegative()),
  /** Lanes that open at this row's node: a curve from `lane` into each, on the row's bottom half. */
  forks: z.array(z.number().int().nonnegative()),
  /** A line enters the node from above / leaves it downwards in `lane`. */
  up: z.boolean(),
  down: z.boolean(),
  /** Number of child rows (the ghost row is not counted). */
  childCount: z.number().int().nonnegative(),
  onActivePath: z.boolean(),
  /** The row that holds pi's current leaf. */
  isLeaf: z.boolean(),
  /** pi label of any entry folded into this row (`/tree` bookmarks, `appendLabelChange`). */
  label: z.string().optional(),
  /** Tokens the row's assistant messages used (input, output and cache writes; cache reads are not counted). */
  tokens: z.number().nonnegative(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  /** First 80 characters of the user message; for the other kinds the row's one-line description. */
  preview: z.string(),
  /** Turn number along the path (`4`), with the branch letter off the active path (`4a`); the branch summary's letter is upper case. */
  number: z.string(),
  /** Count of turns from the root to this row, itself included; `null` for rows that are not turns. */
  turn: z.number().int().positive().nullable(),
  /** Number of pi entries folded into the row. */
  entryCount: z.number().int().nonnegative(),
  timestamp: z.string().optional(),
  // ---- graph v2: what the panel needs so that it makes no further fetch
  /** When the unit finished (its last entry), ISO; the trailing time of the row. `timestamp` is when it began. */
  time: z.string().optional(),
  /** What the turn did: its tool calls in order (consecutive repeats of the same call folded), at most 8. Empty for rows that are not turns. */
  sub: z.array(z.object({ name: z.string(), target: z.string().optional() })),
  /** The model or thinking level differs from the turn before on this path, so the sub line names it. */
  modelChanged: z.boolean(),
  /** Id of the first row of the lane run this row belongs to (`root` for the active path and the ghost): rows of one run share a lane and a line. */
  run: z.string(),
  /** Rows of an abandoned branch (a branch off the active path) carry the id of the branch's first row, and its letter (`A`). Absent on the active path. */
  group: z.string().optional(),
  groupLetter: z.string().optional(),
  /** Context fill after the turn: tokens in the last assistant message's context, the model's window, and the percentage (0 to 100) the ring draws. Absent when the window is unknown. */
  contextPct: z.number().min(0).max(100).optional(),
  contextTokens: z.number().nonnegative().optional(),
  contextWindow: z.number().positive().optional(),
  /** On the first row of a group: what a branch summary written for that branch says (first sentences), when there is one. */
  summary: z.string().optional(),
}).meta({ id: 'TreeRow' });
export type TreeRow = z.infer<typeof TreeRowSchema>;

export type TreeSubPart = TreeRow['sub'][number];

export const SessionTreeSchema = z.object({
  rows: z.array(TreeRowSchema),
  /** pi's current leaf entry (`null` before the first entry). */
  leafId: z.string().nullable(),
  /** The row that holds the leaf. */
  leafRowId: z.string(),
  /** Widest lane in use plus one: the lane cell is this many columns wide. */
  lanes: z.number().int().positive(),
  turns: z.number().int().nonnegative(),
  /** Extra branches: the number of leaves beyond the first (0 for a straight session). */
  forks: z.number().int().nonnegative(),
}).meta({ id: 'SessionTree' });
export type SessionTree = z.infer<typeof SessionTreeSchema>;

export const NavigateRequestSchema = z.object({
  /** The entry to move the leaf to. A user message moves it to that message's parent, as pi's `/tree` does. */
  targetId: z.string().min(1),
  /** Summarise the branch being left and attach the summary at the target (`navigateTree`'s `summarize`). */
  summarize: z.boolean().optional(),
  instructions: z.string().trim().min(1).max(4000).optional(),
}).meta({ id: 'NavigateRequest' });
export type NavigateRequest = z.infer<typeof NavigateRequestSchema>;

export const SummarizeBranchRequestSchema = z.object({
  targetId: z.string().min(1),
  instructions: z.string().trim().min(1).max(4000).optional(),
}).meta({ id: 'SummarizeBranchRequest' });
export type SummarizeBranchRequest = z.infer<typeof SummarizeBranchRequestSchema>;

export const LabelRequestSchema = z.object({
  targetId: z.string().min(1),
  /** An empty string or `null` clears the label. */
  label: z.string().trim().max(80).nullable(),
}).meta({ id: 'LabelRequest' });
export type LabelRequest = z.infer<typeof LabelRequestSchema>;

export const NavigateResultSchema = z.object({
  /** The text of the user message that was the target, for the composer ("Edit and branch"). */
  editorText: z.string().optional(),
  cancelled: z.boolean(),
  leafId: z.string().nullable(),
  /** The id of the branch summary entry, when one was written. */
  summaryId: z.string().optional(),
}).meta({ id: 'NavigateResult' });
export type NavigateResult = z.infer<typeof NavigateResultSchema>;

export const EntryTextSchema = z.object({
  id: z.string(),
  role: z.string(),
  text: z.string(),
  parentId: z.string().nullable(),
}).meta({ id: 'EntryText' });
export type EntryText = z.infer<typeof EntryTextSchema>;

/** `GET /api/threads/:id/tree?raw=1`: pi's entries as they are in the session file, for tools that draw their own graph. */
export const RawSessionTreeSchema = z.object({ entries: z.array(z.unknown()), leafId: z.string().nullable() }).meta({ id: 'RawSessionTree' });
export type RawSessionTree = z.infer<typeof RawSessionTreeSchema>;

export const TreeQuerySchema = z.object({ raw: QueryFlagSchema.optional() });
