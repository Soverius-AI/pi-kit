import { Injectable } from '@nestjs/common';
import { DEFAULT_REDACTION, type RedactionConfig, RedactionConfigSchema, type RedactionPattern, compileUserPatterns, redactJsonl, redactText, redactValue } from '@pi-kit/protocol';
import { MetaRepository } from './meta.repository';
import { ThreadsRepository } from './threads.repository';

const SETTING = 'redaction';

/**
 * The redaction pass on the backend's side: the configuration (user patterns, folders where the pass is off) from the `settings` table, the compiled patterns, and the
 * three places it is applied: events before they are written to the replay log, terminal output before it is kept, and files that leave through an export. The pure functions are in
 * `libs/shared/protocol/src/redact.ts`; this only decides whether they run (per folder) and with which extra patterns. The configuration is read once and again when it is saved.
 */
@Injectable()
export class RedactionService {
  private config: RedactionConfig;
  private extra: RedactionPattern[] = [];
  private errors: string[] = [];
  private readonly cwdOfThread = new Map<string, string>();

  constructor(
    private readonly meta: MetaRepository,
    private readonly threads: ThreadsRepository,
  ) {
    this.config = this.read();
    this.compile();
  }

  private read(): RedactionConfig {
    const parsed = RedactionConfigSchema.safeParse(this.meta.getSetting(SETTING) ?? {});
    return parsed.success ? parsed.data : DEFAULT_REDACTION;
  }

  private compile(): void {
    const { compiled, errors } = compileUserPatterns(this.config.patterns);
    this.extra = compiled;
    this.errors = errors;
  }

  current(): { config: RedactionConfig; errors: string[] } {
    return { config: this.config, errors: this.errors };
  }

  /** Saves the configuration (Settings › Advanced); patterns that are not valid expressions are kept in the list, named in `errors`, and do nothing. */
  save(config: RedactionConfig): { config: RedactionConfig; errors: string[] } {
    this.config = RedactionConfigSchema.parse(config);
    this.meta.setSetting(SETTING, this.config);
    this.compile();
    return this.current();
  }

  /**
   * The user's own patterns, to add to the built-in ones. A transcript that is sent to a model (the learning package) is always redacted, whatever the folder switch
   * says: that switch is for text that looks like a key and is not, on screen, not a licence to send keys to a provider.
   */
  extraPatterns(): readonly RedactionPattern[] {
    return this.extra;
  }

  /** Whether the pass runs for a folder (every folder unless the person switched it off for that one). */
  enabledForCwd(cwd: string | undefined): boolean {
    return !cwd || !this.config.offFor.includes(cwd);
  }

  private cwdFor(threadId: string): string | undefined {
    let cwd = this.cwdOfThread.get(threadId);
    if (cwd === undefined) {
      cwd = this.threads.get(threadId)?.cwd;
      if (cwd !== undefined) this.cwdOfThread.set(threadId, cwd);
    }
    return cwd;
  }

  enabledForThread(threadId: string): boolean {
    return this.enabledForCwd(this.cwdFor(threadId));
  }

  /** An AG-UI event (or any JSON value) of a thread, with its strings redacted; the same object when the pass is off for the thread's folder. */
  event<T>(threadId: string, event: T): T {
    return this.enabledForThread(threadId) ? redactValue(event, this.extra) : event;
  }

  text(cwd: string | undefined, text: string): string {
    return this.enabledForCwd(cwd) ? redactText(text, this.extra).text : text;
  }

  /**
   * pi's HTML export carries the whole session as base64 JSON in `<script id="session-data">`; the data is decoded, redacted and encoded again, so the page shows `[redacted ...]` where
   * the key was. Everything else in the page is pi's template.
   */
  html(cwd: string | undefined, html: string): { text: string; count: number } {
    if (!this.enabledForCwd(cwd)) return { text: html, count: 0 };
    let count = 0;
    const text = html.replace(/(<script id="session-data" type="application\/json">)([A-Za-z0-9+/=]+)(<\/script>)/, (whole, open: string, data: string, close: string) => {
      try {
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        const value = JSON.parse(decoded) as unknown;
        const before = JSON.stringify(value);
        const after = JSON.stringify(redactValue(value, this.extra, new Set<string>()));
        if (before === after) return whole;
        count += 1;
        return `${open}${Buffer.from(after).toString('base64')}${close}`;
      } catch {
        return whole;
      }
    });
    return { text, count };
  }

  /** A pi session file or any JSON Lines text on its way out (export, share, bug report): redacted unless the person switched the pass off for that folder. */
  jsonl(cwd: string | undefined, text: string): { text: string; count: number } {
    return this.enabledForCwd(cwd) ? redactJsonl(text, this.extra) : { text, count: 0 };
  }
}
