import { Injectable, inject } from '@angular/core';
import { ApiClient, setupDetect, unwrap } from '@pi-kit/api';
import { UiStore } from '@pi-kit/data-access';
import { shouldAutoOpen } from '@pi-kit/ui';

/**
 * The launch check of the first-run flow: one `GET /api/setup`, and `UiStore.onboarding` turns on when it is a first run or no provider has a model
 * (`shouldAutoOpen`). This is all that is in the initial bundle; the flow itself, its store and the provider cards are a lazy chunk that loads when the switch turns on.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingLaunch {
  private readonly api = inject(ApiClient);
  private readonly ui = inject(UiStore);

  async check(): Promise<void> {
    try {
      const info = await unwrap(setupDetect({ client: this.api.client, signal: undefined }));
      if (shouldAutoOpen(info)) this.ui.openOnboarding();
    } catch {
      // The backend is not up yet or not reachable: the shell says so; the flow is not what to show then.
    }
  }
}
