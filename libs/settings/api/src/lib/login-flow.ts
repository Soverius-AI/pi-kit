import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingsStore } from '@pi-kit/settings/data';

/**
 * A subscription or Radius sign-in in progress (pi's OAuth and device flow), shown where it was started: in Settings › Providers and in the
 * onboarding's "Get a model" card. It renders `SettingsStore.flow()`: the page to open in the system browser (also offered as a link), the device code to
 * enter, pi's progress lines, and the paste-the-code prompt for a machine the browser cannot call back to (headless, a remote shell). An API-key sign-in is
 * never shown here; that is the workflow dialog.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-login-flow',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.flow(); as flow) {
      @if (flow.type === 'oauth') {
        <div
          class="rounded-box border border-base-300 bg-base-200 p-4 flex flex-col gap-3"
          role="group"
          [attr.aria-label]="('settings.loginFlow.signInTo' | transloco) + flow.providerName"
          data-testid="oauth-flow"
        >
          <div class="flex items-center gap-2">
            <span class="font-medium">{{
              'settings.loginFlow.signInTo7de51' | transloco: { value1: flow.providerName }
            }}</span>
            @if (flow.status === 'starting' || flow.status === 'running') {
              <span class="loading loading-spinner loading-xs"></span>
            }
          </div>
          @for (note of flow.notes; track $index) {
            <p class="t-sm m-0">
              {{ note.text }}
              @if (note.url) {
                <a class="link" [href]="note.url" target="_blank" rel="noopener noreferrer">{{
                  note.label ?? note.url
                }}</a>
              }
            </p>
          }
          @if (flow.authUrl; as auth) {
            <p class="t-sm m-0">
              {{ auth.instructions ?? ('settings.loginFlow.continueInYourBrowser' | transloco) }}
              <a class="link" [href]="auth.url" target="_blank" rel="noopener noreferrer" data-testid="auth-url">{{
                'settings.loginFlow.openTheSignInPage' | transloco
              }}</a>
            </p>
          }
          @if (flow.device; as device) {
            <p class="t-sm m-0">
              {{ 'settings.loginFlow.enter' | transloco }}
              <code class="font-medium" data-testid="device-code">{{ device.userCode }}</code>
              {{ 'settings.loginFlow.at' | transloco }}
              <a class="link" [href]="device.verificationUri" target="_blank" rel="noopener noreferrer">{{
                device.verificationUri
              }}</a
              >.
            </p>
          }
          @if (flow.prompt; as prompt) {
            <form class="flex flex-col gap-2" (submit)="submit($event)">
              <label class="t-sm" [for]="'login-' + prompt.promptId">{{ prompt.message }}</label>
              @if (prompt.kind === 'select') {
                <select name="value" [id]="'login-' + prompt.promptId" class="select select-sm w-full">
                  @for (option of prompt.options ?? []; track option.id) {
                    <option [value]="option.id">{{ option.label }}</option>
                  }
                </select>
              } @else {
                <input
                  name="value"
                  [id]="'login-' + prompt.promptId"
                  class="input input-sm w-full"
                  [type]="prompt.kind === 'secret' ? 'password' : 'text'"
                  [attr.autocomplete]="prompt.kind === 'secret' ? 'off' : null"
                  [placeholder]="prompt.placeholder ?? ''"
                  spellcheck="false"
                />
              }
              <div>
                <button type="submit" class="btn btn-sm btn-primary">
                  {{ 'settings.loginFlow.continue' | transloco }}
                </button>
              </div>
            </form>
          }
          @if (flow.status === 'done') {
            <p class="t-sm text-success m-0" role="status" data-testid="login-done">
              {{ 'settings.loginFlow.signedInTheProviderSModelsAre' | transloco }}
            </p>
          }
          @if (flow.status === 'error') {
            <p class="t-sm text-error break-words m-0" role="alert" data-testid="login-error">{{ flow.error }}</p>
          }
          <div class="flex gap-2">
            @if (flow.status === 'done' || flow.status === 'error') {
              <button type="button" class="btn btn-sm" (click)="store.dismissFlow()">
                {{ 'settings.loginFlow.close' | transloco }}
              </button>
            } @else {
              <button type="button" class="btn btn-sm btn-ghost" (click)="store.cancelLogin()">
                {{ 'settings.loginFlow.cancel' | transloco }}
              </button>
            }
          </div>
        </div>
      }
    }
  `,
})
export class LoginFlow {
  protected readonly store = inject(SettingsStore);

  /** The answer leaves the form’s field and goes to the backend; the field is emptied before anything else happens. */
  protected submit(event: Event): void {
    event.preventDefault();
    const field = (event.target as HTMLFormElement).elements.namedItem('value') as
      HTMLInputElement | HTMLSelectElement | null;
    const value = field?.value ?? '';
    if (field) field.value = '';
    void this.store.answer(value);
  }
}
