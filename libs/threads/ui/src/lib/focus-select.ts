import { Directive, ElementRef, afterNextRender, inject } from '@angular/core';

/** Focuses and selects an input as it appears (the inline rename field). */
@Directive({ selector: 'input[pkFocusSelect]' })
export class FocusSelect {
  constructor() {
    const input = inject<ElementRef<HTMLInputElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      input.focus();
      input.select();
    });
  }
}
