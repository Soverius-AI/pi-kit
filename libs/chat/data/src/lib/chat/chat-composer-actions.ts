import type { Translate } from '@pi-kit/i18n';
import { patchState } from '@ngrx/signals';
import { chipOfCommand, pinnedChips, readPinnedChips, toBase64, withChip } from '@pi-kit/chat/util';
import { readStorage, writeStorage } from '@pi-kit/data-access';
import { type ComposerChip } from '@pi-kit/protocol';
import type { ComposerActionContext } from './chat-action-context';
import { type ImageAttachment, type Notice, PINNED_KEY } from './chat-state';
export function createChatComposerActions(
  translate: Translate,
  store: ComposerActionContext,
  say: (level: Notice['level'], text: string) => void,
) {
  const internal = store._internal;
  // ---- the composer's setters

  function setDraft(text: string, caret?: number): void {
    internal.draftVersion++;
    // An emptied draft forgets the menu the person dismissed with Esc: the next "/" opens it again.
    const forget = text.trim() === '' ? { dismissedFor: undefined } : {};
    patchState(
      store,
      caret === undefined
        ? { draft: text, ...forget }
        : { draft: text, caret, caretRequest: { pos: caret, n: ++internal.caretN }, ...forget },
    );
  }

  function clearDraft(): void {
    internal.draftVersion++;
    patchState(store, { draft: '', caret: 0, images: [], dismissedFor: undefined });
  }

  function insertAt(token: string): void {
    const text = store.draft();
    const at = Math.min(store.caret(), text.length);
    const needsSpace = at > 0 && !/\s/.test(text[at - 1]);
    const inserted = (needsSpace ? ' ' : '') + token;
    setDraft(text.slice(0, at) + inserted + text.slice(at), at + inserted.length);
  }

  /** Dictated or pasted-in text goes at the caret with a space on each side where it would touch a word (voice input). */
  function insertText(text: string): void {
    const words = text.trim();
    if (!words) return;
    const draft = store.draft();
    const at = Math.min(store.caret(), draft.length);
    const before = draft.slice(0, at);
    const after = draft.slice(at);
    const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${words}${after && !/^\s/.test(after) ? ' ' : ''}`;
    setDraft(before + inserted + after, at + inserted.length);
  }

  /** Context captures commit images and text together only while their originating view still owns them. */
  async function addImages(
    files: File[],
    context?: { threadId: string; current: () => boolean | Promise<boolean>; text?: string },
  ): Promise<boolean> {
    const threadId = store.threadId();
    const epoch = internal.threadEpoch;
    const current = (): boolean =>
      !!threadId &&
      threadId === store.threadId() &&
      epoch === internal.threadEpoch &&
      (!context || context.threadId === threadId);
    const images: ImageAttachment[] = [];
    for (const file of files) {
      if (file.size > store._policy.maxImageBytes) {
        say(
          'warning',
          translate('chat.chatComposerActions.isLargerThanMBItWasNot', {
            value1: file.name || translate('chat.chatComposerActions.theImage'),
            value2: store._policy.maxImageBytes / (1024 * 1024),
          }),
        );
        continue;
      }
      const data = await toBase64(file);
      if (!current()) return false;
      images.push({ id: crypto.randomUUID(), mimeType: file.type || 'image/png', data, name: file.name || undefined });
    }
    if (context && !(await context.current())) return false;
    if (!current() || (files.length > 0 && images.length === 0)) return false;
    patchState(store, (s) => ({ images: [...s.images, ...images] }));
    if (context?.text) insertText(context.text);
    return true;
  }

  // ---- skill and prompt-template chips

  /** Replaces the chips of the open thread; the pinned ones are written to `localStorage` when they changed. */
  function setChips(next: readonly ComposerChip[], threadId = store.threadId()): void {
    if (!threadId) return;
    const before = pinnedChips(store.chipsByThread()[threadId] ?? []);
    patchState(store, (s) => {
      const copy = { ...s.chipsByThread };
      if (next.length === 0) delete copy[threadId];
      else copy[threadId] = [...next];
      return { chipsByThread: copy };
    });
    const after = pinnedChips(next);
    if (before.length === after.length && before.every((c, i) => c.kind === after[i].kind && c.name === after[i].name))
      return;
    const saved = readPinnedChips(readStorage(PINNED_KEY));
    delete saved[threadId];
    if (after.length > 0) saved[threadId] = after.map((c) => ({ ...c }));
    writeStorage(
      PINNED_KEY,
      JSON.stringify(Object.fromEntries(Object.entries(saved).slice(-store._policy.pinnedThreads))),
    );
  }

  /** Puts a chip in the composer; a skill or template that is already there stays where it is. Returns whether it was added. */
  function addChip(chip: Omit<ComposerChip, 'pinned'> & { pinned?: boolean }): boolean {
    const threadId = store.threadId();
    if (!threadId) return false;
    const before = store.chips();
    const next = withChip(before, { pinned: false, ...chip });
    if (next === before) return false;
    setChips(next);
    return true;
  }

  /** A skill or prompt template from the command list as a chip (`skill:pdf-tools`, `review`); false for any other command. */
  function addCommandChip(name: string): boolean {
    const command = store.commands().find((c) => c.name === name);
    const chip = command && chipOfCommand(command);
    return chip ? addChip(chip) : false;
  }

  return { setDraft, clearDraft, insertAt, insertText, addImages, setChips, addChip, addCommandChip };
}
