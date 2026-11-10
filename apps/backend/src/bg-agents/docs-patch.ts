import type { JsonPatchOperation } from '@ag-ui/core';
import { applyImmutable, type Op, type Path } from '@earendil-works/chord/delta';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable';

/** What one watch call did to the transcript and to the answer being streamed (`pi.live.generation.message`), in commit order. */
export type StreamChange =
  /** An entry appended to the transcript. */
  | { readonly kind: 'entry'; readonly entry: EntryRecord }
  /** The answer appeared, or was replaced or rewritten: what was streamed of it before no longer holds. */
  | { readonly kind: 'message'; readonly message: AssistantMessage }
  /** A block appended to the answer. */
  | { readonly kind: 'block'; readonly index: number; readonly block: AssistantMessage['content'][number] }
  /** Text appended to a text or thinking block of the answer, as pi appended it. */
  | { readonly kind: 'append'; readonly index: number; readonly field: 'text' | 'thinking'; readonly text: string }
  /** The answer left `pi.live`: its entry follows in the same commit, or it ended without one. */
  | { readonly kind: 'gone' };

/**
 * pi's operations of one watch call on a conversation view. On its documents they become an RFC 6902 JSON Patch against
 * `{ docs }`, the content of the `pi.agent_live` activity, which leaves out the answer being streamed; on that answer and on the
 * transcript they become `StreamChange`s, which the mapper turns into messages. A mirror of the documents tells an `add` from a
 * `replace`, and gives the new value of a string appended to or trimmed (JSON Patch has no append) and of an array permuted.
 */
export class DocsPatch {
  /** Where the answer being streamed sits in a view. */
  static readonly MESSAGE: Path = ['docs', 'pi.live', 'generation', 'message'];
  private content: { docs: ConversationView['docs'] };

  constructor(docs: ConversationView['docs']) {
    this.content = { docs };
  }

  /**
   * The patch and the stream changes of the operations of one watch call, which turn the view before into one with `docs`;
   * null when one replaced the whole view, so only snapshots will do. Operations on the window (`before`) are skipped.
   */
  next(
    ops: readonly Op[],
    docs: ConversationView['docs'],
  ): { patch: JsonPatchOperation[]; changes: StreamChange[] } | null {
    let content: unknown = this.content;
    this.content = { docs };
    const patch: JsonPatchOperation[] = [];
    const changes: StreamChange[] = [];
    for (const op of ops) {
      if (op[0] === 'r') return null;
      const path = op[1];
      if (path[0] === 'entries') {
        if (op[0] === 'p')
          for (const entry of op[4]) changes.push({ kind: 'entry', entry: entry as unknown as EntryRecord });
        else if (op[0] === 's' && path.length === 2)
          changes.push({ kind: 'entry', entry: op[2] as unknown as EntryRecord });
        continue;
      }
      if (path[0] !== 'docs') continue;
      const before = content;
      content = applyImmutable(before, [op]);
      if (DocsPatch.within(path, DocsPatch.MESSAGE)) {
        changes.push(...DocsPatch.stream(op, before, content));
        continue;
      }
      const above = DocsPatch.within(DocsPatch.MESSAGE, path);
      if (above) {
        const was = DocsPatch.at(before, DocsPatch.MESSAGE).value;
        const now = DocsPatch.at(content, DocsPatch.MESSAGE).value as AssistantMessage | undefined;
        if (now !== was) changes.push(now === undefined ? { kind: 'gone' } : { kind: 'message', message: now });
      }
      const pointer = DocsPatch.pointer(path);
      switch (op[0]) {
        case 's':
          patch.push({
            op: DocsPatch.at(before, path).found ? 'replace' : 'add',
            path: pointer,
            value: above ? DocsPatch.without(op[2], DocsPatch.MESSAGE.slice(path.length)) : op[2],
          });
          break;
        case 'd':
          patch.push({ op: 'remove', path: pointer });
          break;
        case 'a':
        case 't':
        case 'm':
          patch.push({ op: 'replace', path: pointer, value: DocsPatch.at(content, path).value });
          break;
        case 'p': {
          const [, , start, deleted, items] = op;
          for (let i = 0; i < deleted; i++) patch.push({ op: 'remove', path: `${pointer}/${start}` });
          items.forEach((value, i) => patch.push({ op: 'add', path: `${pointer}/${start + i}`, value }));
          break;
        }
      }
    }
    return { patch, changes };
  }

  /** The documents as the activity carries them: without the answer being streamed, which is a message of its own. */
  static strip(docs: ConversationView['docs']): ConversationView['docs'] {
    return DocsPatch.without(docs, DocsPatch.MESSAGE.slice(1)) as ConversationView['docs'];
  }

  /** A JSON Pointer (RFC 6901): `~` is written `~0`, `/` is written `~1`. */
  static pointer(path: Path): string {
    return path.map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
  }

  /**
   * An operation at or under the answer being streamed as what it does to the answer: a text appended, a block appended, or a
   * rewrite that voids what was streamed. Nothing for its other fields, or a tool call's arguments, which its entry carries.
   */
  private static stream(op: Exclude<Op, { readonly 0: 'r' }>, before: unknown, after: unknown): StreamChange[] {
    const rest = op[1].slice(DocsPatch.MESSAGE.length);
    const message = DocsPatch.at(after, DocsPatch.MESSAGE).value as AssistantMessage | undefined;
    const rewritten: StreamChange[] = [message ? { kind: 'message', message } : { kind: 'gone' }];
    if (rest.length === 0) return rewritten;
    if (rest[0] !== 'content') return [];
    const blocks = (DocsPatch.at(before, [...DocsPatch.MESSAGE, 'content']).value as unknown[] | undefined)?.length;
    const [, index, field] = rest;
    if (op[0] === 'p' && rest.length === 1 && op[3] === 0 && op[2] === blocks)
      return op[4].map((block, i) => ({
        kind: 'block',
        index: op[2] + i,
        block: block as unknown as AssistantMessage['content'][number],
      }));
    if (op[0] === 's' && rest.length === 2 && index === blocks)
      return [{ kind: 'block', index, block: op[2] as unknown as AssistantMessage['content'][number] }];
    if (rest.length === 3 && (field === 'text' || field === 'thinking'))
      return op[0] === 'a' && typeof index === 'number' ? [{ kind: 'append', index, field, text: op[2] }] : rewritten;
    return rest.length >= 3 ? [] : rewritten;
  }

  /** Whether `path` is `prefix` or lies under it. */
  private static within(path: Path, prefix: Path): boolean {
    return prefix.length <= path.length && prefix.every((segment, i) => path[i] === segment);
  }

  /** `value` without what lies at `path` under it, copied along the path. */
  private static without(value: unknown, path: Path): unknown {
    const [key, ...rest] = path;
    if (
      key === undefined ||
      typeof value !== 'object' ||
      value === null ||
      !Object.prototype.hasOwnProperty.call(value, key)
    )
      return value;
    const { [key]: inner, ...others } = value as Record<string | number, unknown>;
    return rest.length === 0 ? others : { ...others, [key]: DocsPatch.without(inner, rest) };
  }

  private static at(content: unknown, path: Path): { found: boolean; value?: unknown } {
    let node = content;
    for (const segment of path) {
      if (typeof node !== 'object' || node === null || !Object.prototype.hasOwnProperty.call(node, segment))
        return { found: false };
      node = (node as Record<string | number, unknown>)[segment];
    }
    return { found: true, value: node };
  }
}
