import type { CompactionUsage, ModelUsage, ThreadUsage, TurnUsage } from '@pi-kit/protocol';
import { type PiSessionEntry, userMessageText } from './session-messages';

/**
 * Usage of a whole session file, summed the way pi's `getSessionStats()` does: every entry in the file regardless of the
 * branch it is on, counting assistant messages, tool results that report nested model work, `usage` entries (cache warming) and the
 * `usage` of compaction and branch-summary entries. Pure: give it the parsed entries (header excluded), get the numbers.
 *
 * The turn of an entry is the nearest user message above it along `parentId`, so a session with branches attributes each branch's
 * requests to that branch's own user messages. Turns are numbered in file order, which is not the number the transcript shows for a
 * branched session (the transcript counts the active path).
 */

interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  requests: number;
}

const zero = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 });

function add(into: Counts, usage: RawUsage): void {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  into.input += input;
  into.output += output;
  into.cacheRead += cacheRead;
  into.cacheWrite += cacheWrite;
  into.total += input + output + cacheRead + cacheWrite;
  into.cost += usage.cost?.total ?? 0;
  into.requests += 1;
}

interface Charge {
  usage: RawUsage;
  provider: string;
  model: string;
  elapsedMs?: number;
}

const time = (entry: PiSessionEntry | undefined): number | undefined => {
  const t = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** What an entry cost, if it cost anything (the same entries `getSessionStats()` reads). */
function chargesOf(entry: PiSessionEntry, parent: PiSessionEntry | undefined): Charge[] {
  const message = entry.type === 'message' ? (entry['message'] as { role?: string; usage?: RawUsage; provider?: string; model?: string } | undefined) : undefined;
  if (message?.role === 'assistant' && message.usage) {
    const end = time(entry);
    const start = time(parent);
    return [
      {
        usage: message.usage,
        provider: message.provider ?? '',
        model: message.model ?? 'unknown model',
        ...(end !== undefined && start !== undefined && end >= start ? { elapsedMs: end - start } : {}),
      },
    ];
  }
  if (message?.role === 'toolResult' && message.usage) return [{ usage: message.usage, provider: '', model: 'nested tool usage' }];
  if (entry.type === 'usage' && entry['usage']) {
    return [{ usage: entry['usage'] as RawUsage, provider: String(entry['provider'] ?? ''), model: String(entry['model'] ?? entry['kind'] ?? 'usage') }];
  }
  if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry['usage']) {
    return [{ usage: entry['usage'] as RawUsage, provider: String(entry['provider'] ?? ''), model: String(entry['model'] ?? (entry.type === 'compaction' ? 'compaction summary' : 'branch summary')) }];
  }
  return [];
}

export function aggregateUsage(entries: readonly PiSessionEntry[], meta: { sessionId: string; sessionFile: string | null }): ThreadUsage {
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const userTurn = new Map<string, number>();
  const turnEntry = new Map<number, string>();
  let turns = 0;
  for (const entry of entries) {
    if (entry.type === 'message' && (entry['message'] as { role?: string } | undefined)?.role === 'user') {
      userTurn.set(entry.id, ++turns);
      turnEntry.set(turns, entry.id);
    }
  }

  const turnOfCache = new Map<string, number>();
  const turnOf = (entry: PiSessionEntry): number => {
    const path: string[] = [];
    let turn = 0;
    for (let current: PiSessionEntry | undefined = entry; current; current = current.parentId ? byId.get(current.parentId) : undefined) {
      const known = userTurn.get(current.id) ?? turnOfCache.get(current.id);
      if (known !== undefined) {
        turn = known;
        break;
      }
      path.push(current.id);
      if (path.length > entries.length) break;
    }
    for (const id of path) turnOfCache.set(id, turn);
    return turn;
  };

  const totals = zero();
  const models = new Map<string, ModelUsage>();
  const rows = new Map<number, TurnUsage & { _models: Set<string> }>();
  const row = (turn: number) => {
    let r = rows.get(turn);
    if (!r) {
      const entry = turnEntry.get(turn);
      const user = entry ? byId.get(entry) : undefined;
      const content = (user?.['message'] as { content?: Parameters<typeof userMessageText>[0] } | undefined)?.content;
      const preview = turn === 0 ? 'Before the first message' : userMessageText(content).replace(/\s+/g, ' ').trim().slice(0, 80);
      r = { turn, ...(entry ? { entryId: entry } : {}), ...(user?.timestamp ? { timestamp: user.timestamp } : {}), preview, models: [], ...zero(), _models: new Set() };
      rows.set(turn, r);
    }
    return r;
  };

  for (const entry of entries) {
    const charges = chargesOf(entry, entry.parentId ? byId.get(entry.parentId) : undefined);
    if (charges.length === 0) continue;
    const turn = row(turnOf(entry));
    for (const charge of charges) {
      add(totals, charge.usage);
      add(turn, charge.usage);
      const key = `${charge.provider}\0${charge.model}`;
      let model = models.get(key);
      if (!model) models.set(key, (model = { provider: charge.provider, model: charge.model, ...zero() }));
      add(model, charge.usage);
      const label = charge.provider ? `${charge.provider}/${charge.model}` : charge.model;
      if (!turn._models.has(label)) {
        turn._models.add(label);
        turn.models.push(label);
      }
      if (charge.elapsedMs !== undefined) turn.elapsedMs = (turn.elapsedMs ?? 0) + charge.elapsedMs;
    }
  }

  const compactions: CompactionUsage[] = [];
  entries.forEach((entry, index) => {
    if (entry.type !== 'compaction') return;
    // The first response below the compaction shows how big the context really was afterwards.
    let tokensAfter: number | undefined;
    for (let i = index + 1; i < entries.length && tokensAfter === undefined; i++) {
      const next = entries[i];
      const message = next.type === 'message' ? (next['message'] as { role?: string; usage?: RawUsage } | undefined) : undefined;
      if (message?.role !== 'assistant' || !message.usage) continue;
      for (let up: PiSessionEntry | undefined = next; up; up = up.parentId ? byId.get(up.parentId) : undefined) {
        if (up.id === entry.id) {
          tokensAfter = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
          break;
        }
      }
    }
    compactions.push({
      entryId: entry.id,
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      tokensBefore: typeof entry['tokensBefore'] === 'number' ? entry['tokensBefore'] : 0,
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    });
  });

  const sent = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    sessionId: meta.sessionId,
    sessionFile: meta.sessionFile,
    totals: { ...totals, turns },
    cacheHitRatio: sent > 0 ? totals.cacheRead / sent : null,
    byModel: [...models.values()].sort((a, b) => b.cost - a.cost || b.total - a.total),
    byTurn: [...rows.values()].sort((a, b) => a.turn - b.turn).map(({ _models, ...turn }) => turn),
    compactions,
  };
}
