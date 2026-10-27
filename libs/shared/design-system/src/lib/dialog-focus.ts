import { Injector, afterNextRender } from '@angular/core';

/**
 * After the next render, puts the focus back on a dialog's window when it has gone out of the dialog. A button that is clicked and then disabled (Continue while the next step loads,
 * Save while it saves), or that is taken out of the foot (Remove server… turning into its confirmation), takes the focus with it, and with the focus on the page an Escape belongs to the
 * app's own shortcut, which closes the whole Settings window and not the dialog on top of it. A dialog keeps its focus where its own Escape handler hears it.
 */
export function keepFocusInside(injector: Injector, window: () => HTMLElement | undefined): void {
  afterNextRender(
    () => {
      const win = window();
      if (win && !win.contains(document.activeElement)) win.focus();
    },
    { injector },
  );
}
