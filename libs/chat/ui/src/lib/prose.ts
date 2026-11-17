import {
  ApplicationRef,
  Component,
  type ComponentRef,
  DestroyRef,
  type ElementRef,
  EnvironmentInjector,
  Injector,
  afterRenderEffect,
  computed,
  createComponent,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { CodeBlock } from './code-block';
import { MarkdownService } from './markdown';
import { markdownFragment } from './markdown-dom';
import { MermaidDiagram } from './mermaid-diagram';

type BlockView =
  { kind: 'code'; ref: ComponentRef<CodeBlock> } | { kind: 'mermaid'; ref: ComponentRef<MermaidDiagram> };

/** Sanitized prose plus stable Angular code/diagram blocks, also inside lists and blockquotes. */
@Component({
  selector: 'pk-prose',
  host: { class: 'block' },
  template: `<div #container class="prose" [class.pk-caret]="streaming()"></div>`,
})
export class Prose {
  readonly text = input.required<string>();
  readonly streaming = input(false);
  private readonly markdown = inject(MarkdownService);
  private readonly document = computed(() => this.markdown.document(this.text(), this.streaming()));
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  private readonly app = inject(ApplicationRef);
  private readonly environmentInjector = inject(EnvironmentInjector);
  private readonly injector = inject(Injector);
  private readonly views = new Map<number, BlockView>();

  constructor() {
    afterRenderEffect(() => {
      const rendered = this.document();
      const container = this.container().nativeElement;
      const fragment = markdownFragment(rendered.html);
      if (!fragment) {
        this.clearViews();
        container.textContent = this.text();
        return;
      }
      const active = new Set<number>();
      for (const slot of fragment.querySelectorAll<HTMLElement>('[data-pk-block]')) {
        const index = Number(slot.dataset['pkBlock']);
        const block = rendered.blocks[index];
        if (!block) continue;
        active.add(index);
        let view = this.views.get(index);
        if (view && view.kind !== block.kind) {
          view.ref.destroy();
          view = undefined;
        }
        if (!view) {
          view =
            block.kind === 'mermaid'
              ? {
                  kind: 'mermaid',
                  ref: createComponent(MermaidDiagram, {
                    environmentInjector: this.environmentInjector,
                    elementInjector: this.injector,
                  }),
                }
              : {
                  kind: 'code',
                  ref: createComponent(CodeBlock, {
                    environmentInjector: this.environmentInjector,
                    elementInjector: this.injector,
                  }),
                };
          this.app.attachView(view.ref.hostView);
          this.views.set(index, view);
        }
        if (view.kind === 'mermaid') {
          view.ref.setInput('source', block.code);
          view.ref.setInput('streaming', block.streaming);
        } else {
          view.ref.setInput('code', block.code);
          view.ref.setInput('language', block.language);
        }
        // Move the existing component host into the new sanitized tree rather than recreating it on every token.
        // Mermaid can keep its last successful SVG while the next partial source is invalid.
        slot.replaceWith(view.ref.location.nativeElement as HTMLElement);
      }
      for (const [index, view] of this.views) {
        if (!active.has(index)) {
          view.ref.destroy();
          this.views.delete(index);
        }
      }
      container.replaceChildren(fragment);
    });
    inject(DestroyRef).onDestroy(() => this.clearViews());
  }

  private clearViews(): void {
    for (const view of this.views.values()) view.ref.destroy();
    this.views.clear();
  }
}
