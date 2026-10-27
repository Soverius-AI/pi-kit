import { Injectable, type Signal, type WritableSignal, computed, inject } from '@angular/core';
import { type Attachment, ChatState, type Suggestion } from '@copilotkit/angular';
import { PATH_DRAG_TYPE } from '@pi-kit/ui';
import { ChatStore } from '@pi-kit/chat/data';

/** A writable view over store state: reads follow the store, writes go through its methods. */
function view<T>(read: () => T, write: (value: T) => void): WritableSignal<T> {
  const signal = computed(read);
  return Object.assign(signal, {
    set: write,
    update: (fn: (value: T) => T) => write(fn(read())),
    asReadonly: (): Signal<T> => signal,
  }) as unknown as WritableSignal<T>;
}

/**
 * CopilotKit's seam between the chat view and whoever owns the conversation (`CopilotChat` is the stock owner): the input value, the
 * attachments, the suggestions and the drag and drop of files. pi-kit's owner is `ChatStore`; this class only translates.
 * The chat page provides it as `ChatState`.
 */
@Injectable()
export class PkChatState extends ChatState {
  private readonly chat = inject(ChatStore);

  readonly inputValue = view(
    () => this.chat.draft(),
    (value) => this.chat.setDraft(value),
  );

  /** The images in the draft and the `@paths` of its text, as CopilotKit's attachment queue draws them. */
  override readonly attachments = view<Attachment[]>(
    () => [
      ...this.chat.images().map((image): Attachment => ({
        id: image.id,
        type: 'image',
        source: { type: 'data', value: image.data, mimeType: image.mimeType },
        filename: image.name,
        status: 'ready',
      })),
      ...this.chat.fileChips().map((path): Attachment => ({
        id: `file:${path}`,
        type: 'document',
        source: { type: 'url', value: path, mimeType: 'text/plain' },
        filename: path,
        status: 'ready',
      })),
    ],
    () => undefined,
  );
  override readonly attachmentsEnabled = computed(() => !!this.chat.threadId());
  override readonly suggestions = view<Suggestion[]>(
    () => this.chat.suggestionItems().map((s) => ({ title: s.title, message: s.text, isLoading: false })),
    () => undefined,
  );

  submitInput(): void {
    void this.chat.submit();
  }

  changeInput(value: string): void {
    this.chat.setDraft(value);
  }

  override selectSuggestion(_suggestion: Suggestion, index: number): void {
    const item = this.chat.suggestionItems()[index];
    if (item) void this.chat.chooseSuggestion(item);
  }

  /** The image picker. */
  override addFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.multiple = true;
    input.onchange = () => void this.chat.addImages(Array.from(input.files ?? []));
    input.click();
  }

  override removeAttachment(id: string): void {
    if (id.startsWith('file:')) this.chat.removeFileChip(id.slice('file:'.length));
    else this.chat.removeImage(id);
  }

  // A row of the Files panel (or an image) dropped anywhere on the chat view.
  override handleDragOver(event: DragEvent): void {
    if (
      this.chat.threadId() &&
      (event.dataTransfer?.types.includes(PATH_DRAG_TYPE) || event.dataTransfer?.types.includes('Files'))
    ) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    }
  }

  /** A dropped row becomes `@path` at the caret (pi reads the file itself); dropped images are attached. */
  override handleDrop(event: DragEvent): void {
    if (!this.chat.threadId()) return;
    const reference = event.dataTransfer?.getData(PATH_DRAG_TYPE);
    if (reference) {
      event.preventDefault();
      this.chat.insertAt(reference.endsWith('/') ? reference : `${reference} `);
      this.chat.focusComposer();
      return;
    }
    const images = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (images.length > 0) {
      event.preventDefault();
      void this.chat.addImages(images);
    }
  }
}
