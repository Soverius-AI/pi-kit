import { LEASE_TTL_MS } from './leases';

/** One agent that works next to the thread in the same folder, or in a worktree of the same repository. */
export interface OtherAgent {
  title: string;
  /** `terminal`: the pi command line, found from its session file (no lease details). */
  state: 'running' | 'idle' | 'waiting' | 'terminal';
  relation: 'same-folder' | 'worktree';
  branch: string | null;
  /** Files it edited in the last 30 minutes, newest first. */
  files: { path: string; at: number }[];
  /** For the command line: when its session file last changed. */
  lastActiveAt?: number;
}

export const SECTION_TITLE = 'Other agents in this workspace';

/** The three rules the section ends. */
export const SECTION_RULES = [
  'Do not edit a file another agent is editing without saying so first.',
  'Prefer small, self-contained changes.',
  'If a conflict is likely, say so in the answer instead of guessing.',
] as const;

/** At most this many files are named per agent; the rest is counted. */
const FILES_PER_AGENT = 8;

/** "just now", "3 min ago", "1 h ago". */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

const STATE_WORD: Record<OtherAgent['state'], string> = { running: 'running', idle: 'idle', waiting: 'waiting for input', terminal: 'pi in a terminal' };

/**
 * The text of the system-prompt section "Other agents in this workspace": for every other agent its title, state, where it works (this folder, or its
 * own worktree and branch) and the files it edited in the last 30 minutes, then the three rules. `undefined` when there is no other agent, so a thread
 * that is alone gets exactly the prompt it always did.
 */
export function buildSection(agents: readonly OtherAgent[], now: number): string | undefined {
  if (agents.length === 0) return undefined;
  const lines: string[] = [
    SECTION_TITLE,
    'Working in this repository right now (information from pi-kit, not a lock):',
  ];
  for (const agent of agents) {
    const where = agent.relation === 'same-folder' ? 'this same folder' : `its own worktree${agent.branch ? ` (branch ${agent.branch})` : ''}`;
    const head = agent.state === 'terminal' ? `- ${agent.title} (${STATE_WORD.terminal}, ${where}${agent.lastActiveAt ? `, last active ${ago(agent.lastActiveAt, now)}` : ''})` : `- "${agent.title}" (${STATE_WORD[agent.state]}, ${where})`;
    if (agent.state === 'terminal') {
      lines.push(`${head}: no file details.`);
    } else if (agent.files.length === 0) {
      lines.push(`${head}: no files edited in the last ${LEASE_TTL_MS / 60_000} minutes.`);
    } else {
      const shown = agent.files.slice(0, FILES_PER_AGENT).map((f) => `${f.path} (${ago(f.at, now)})`);
      const more = agent.files.length - shown.length;
      lines.push(`${head}: edited ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`);
    }
  }
  lines.push('', 'Rules:', ...SECTION_RULES.map((rule) => `- ${rule}`));
  return lines.join('\n');
}

/** What another thread did to a file, as a lease says it. */
export interface OtherLease {
  threadId: string;
  title: string;
  path: string;
  at: number;
}

export interface Notice {
  path: string;
  titles: string[];
  at: number;
  text: string;
}

/**
 * The notices for the next turn boundary: for every file this thread read or edited (`touched`, when it last did) that another thread edited after
 * that, and that the model was not already told about (`told`: the activity time the last notice for the file was about). One notice per file: several
 * threads that changed the same file are named in one line, and the same change is never announced twice. A file this thread read again after the change
 * needs no notice (its `touched` time is newer).
 */
export function computeNotices(input: { touched: ReadonlyMap<string, number>; leases: readonly OtherLease[]; told: ReadonlyMap<string, number> }): Notice[] {
  const byPath = new Map<string, OtherLease[]>();
  for (const lease of input.leases) {
    const mine = input.touched.get(lease.path);
    if (mine === undefined || lease.at <= mine || lease.at <= (input.told.get(lease.path) ?? 0)) continue;
    byPath.set(lease.path, [...(byPath.get(lease.path) ?? []), lease]);
  }
  return [...byPath.entries()]
    .map(([path, leases]) => {
      const titles = [...new Set(leases.map((l) => l.title))];
      const names = titles.map((t) => `*${t}*`);
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
      return { path, titles, at: Math.max(...leases.map((l) => l.at)), text: `${who} changed \`${path}\` since you last read it.` };
    })
    .sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
}
