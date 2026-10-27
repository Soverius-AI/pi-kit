import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { onboardingSteps } from '@pi-kit/ui';
import { OnboardingStore } from '@pi-kit/onboarding/data';
import { PkIcon } from '@pi-kit/design-system';

/**
 * The last step of the onboarding is not a card: the flow docks into this strip above the real chat page, so the first prompt is typed into the real
 * composer and answered in the real transcript. The strip shows the progress, the live "pi is ready" check (one cheap request through the default model), three
 * suggested prompts that fill the composer, and the way out: Finish (the normal window) or Back to the folder card.
 */
@Component({
  imports: [TranslocoPipe, PkIcon],
  selector: 'pk-onboarding-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ob.docked()) {
      <section
        class="pk-ob-strip"
        role="region"
        [attr.aria-label]="'onboarding.onboardingStrip.setupLastStep' | transloco"
        data-testid="onboarding-strip"
      >
        <div class="top">
          <span
            class="dots"
            [attr.aria-label]="
              ('onboarding.onboardingStrip.step' | transloco) +
              ob.stepNumber() +
              ('onboarding.onboardingStrip.of' | transloco) +
              total
            "
            role="img"
          >
            @for (step of steps; track step.id) {
              <i class="on"></i>
            }
          </span>
          <strong class="title">{{ 'onboarding.onboardingStrip.firstPrompt' | transloco }}</strong>
          @switch (ob.ready().phase) {
            @case ('checking') {
              <span class="chip" role="status" data-testid="ready-chip"
                ><span class="loading loading-spinner loading-xs"></span>
                {{ 'onboarding.onboardingStrip.checkingPi' | transloco }}</span
              >
            }
            @case ('done') {
              @if (result(); as r) {
                <span
                  class="chip"
                  [class.ok]="r.ok"
                  [class.err]="!r.ok"
                  role="status"
                  data-testid="ready-chip"
                  [attr.data-ready]="r.ok ? 'yes' : 'no'"
                  >{{
                    r.ok
                      ? ('onboarding.onboardingStrip.piIsReady' | transloco)
                      : ('onboarding.onboardingStrip.piIsNotReady' | transloco)
                  }}</span
                >
                <span class="detail t-sm muted truncate" data-testid="ready-detail">{{
                  r.ok ? r.model + ('onboarding.onboardingStrip.answeredIn' | transloco) + seconds(r.ms) : r.message
                }}</span>
                @if (!r.ok) {
                  <button type="button" class="btn btn-xs" (click)="ob.checkReady()">
                    {{ 'onboarding.onboardingStrip.checkAgain' | transloco }}
                  </button>
                }
              }
            }
          }
          <span class="ml-auto flex items-center gap-2 shrink-0">
            <button type="button" class="btn btn-sm btn-ghost" data-testid="strip-back" (click)="ob.back()">
              <pk-icon name="chevron-left" size="16" />{{ 'onboarding.onboardingStrip.back' | transloco }}
            </button>
            <button type="button" class="btn btn-sm btn-primary" data-testid="finish-setup" (click)="ob.finish()">
              {{ 'onboarding.onboardingStrip.finishSetup' | transloco }}
            </button>
          </span>
        </div>
        <div
          class="prompts"
          role="group"
          [attr.aria-label]="'onboarding.onboardingStrip.suggestedFirstPrompts' | transloco"
        >
          <span class="t-sm muted shrink-0">{{ 'onboarding.onboardingStrip.tryOneThenPressEnter' | transloco }}</span>
          @for (text of ob.prompts(); track text) {
            <button
              type="button"
              class="chip pill"
              data-testid="suggested-prompt"
              [title]="text"
              (click)="ob.usePrompt(text)"
            >
              {{ text }}
            </button>
          }
        </div>
      </section>
    }
  `,
})
export class OnboardingStrip {
  protected readonly i18n = inject(Language);
  protected readonly ob = inject(OnboardingStore);
  protected get steps() {
    return onboardingSteps(this.i18n.t);
  }
  protected readonly total = onboardingSteps(this.i18n.t).length;

  protected result() {
    const ready = this.ob.ready();
    return ready.phase === 'done' ? ready.result : undefined;
  }

  protected seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
  }
}
