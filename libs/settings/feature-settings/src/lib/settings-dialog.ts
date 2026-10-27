import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UiStore } from '@pi-kit/data-access';
import { SettingsWindow } from './settings-window';

/**
 * The Settings entry point in the app shell. The window itself (the nav, the search, the sections, the API-key workflow) is a lazy
 * chunk: it is fetched the first time Settings is asked for (and warmed up when the browser is idle), so it stays out of the initial bundle, whose
 * budget is tight. What must work before that chunk exists lives in `UiStore`: `settings` is the switch the chat code calls, and the sidebar's
 * “N MCP servers” and `/mcp` (`openMcpPanel`) open Settings › MCP servers.
 */
@Component({
  selector: 'pk-settings-dialog',
  imports: [SettingsWindow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @defer (when bus.settings() !== null; prefetch on idle) {
      <pk-settings-window />
    }
  `,
})
export class SettingsDialog {
  protected readonly bus = inject(UiStore);
}
