import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import {
  EntryApiClient,
  errorMessage,
  instanceIdentity,
  instanceRename,
  isDeviceConnection,
  unwrap,
} from '@pi-kit/api';
import { TranslocoPipe } from '@pi-kit/i18n';
import { PkSetting } from '@pi-kit/settings/api';
import { EnvironmentNameSchema, type Environment } from '@pi-kit/protocol';

/** Naming does not change identity, folders, project ownership or publication consent. */
@Component({
  selector: 'pk-environment-section',
  imports: [TranslocoPipe, PkSetting],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="pk-group"
      data-testid="environment-section"
      [attr.aria-busy]="busy()"
      [attr.aria-label]="'settings.environmentSection.title' | transloco"
    >
      <header>
        <h4>{{ 'settings.environmentSection.title' | transloco }}</h4>
      </header>
      @if (environment(); as environment) {
        <form pkSetting="environment-name" (submit)="$event.preventDefault(); save()">
          <p sub class="sub mono" data-testid="environment-identity">{{ environment.instanceId }}</p>
          @if (!valid()) {
            <p sub class="sub err" id="instance-name-error" role="alert">
              {{ 'settings.environmentSection.invalid' | transloco }}
            </p>
          }
          <input
            id="instance-name"
            class="input input-sm"
            data-testid="environment-name"
            maxlength="80"
            aria-labelledby="lbl-environment-name"
            [value]="name()"
            (input)="name.set($any($event.target).value)"
            [disabled]="busy() || readOnly"
            [attr.aria-invalid]="!valid()"
            [attr.aria-describedby]="valid() ? 'hint-environment-name' : 'hint-environment-name instance-name-error'"
          />
          @if (!readOnly) {
            <button type="submit" class="btn btn-sm" data-testid="environment-save" [disabled]="!canSave()">
              {{ 'settings.environmentSection.save' | transloco }}
            </button>
          }
        </form>
      }
      @if (error(); as error) {
        <p class="row sub err" role="alert" data-testid="environment-error">{{ error }}</p>
      }
    </section>
  `,
})
export class EnvironmentSection implements OnInit {
  private readonly api = inject(EntryApiClient);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly readOnly = isDeviceConnection();
  protected readonly environment = signal<Environment | undefined>(undefined);
  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly valid = computed(() => EnvironmentNameSchema.safeParse(this.name()).success);
  protected readonly canSave = computed(
    () => !this.readOnly && !this.busy() && this.valid() && this.name().trim() !== this.environment()?.name,
  );

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.busy.set(true);
    try {
      const environment = await unwrap(instanceIdentity({ client: this.api.client }));
      if (!this.destroyRef.destroyed) {
        this.environment.set(environment);
        this.name.set(environment.name);
      }
    } catch (error) {
      if (!this.destroyRef.destroyed) this.error.set(errorMessage(error));
    } finally {
      if (!this.destroyRef.destroyed) this.busy.set(false);
    }
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.busy.set(true);
    this.error.set(undefined);
    try {
      const environment = await unwrap(instanceRename({ client: this.api.client, body: { name: this.name().trim() } }));
      if (!this.destroyRef.destroyed) {
        this.environment.set(environment);
        this.name.set(environment.name);
      }
    } catch (error) {
      if (!this.destroyRef.destroyed) this.error.set(errorMessage(error));
    } finally {
      if (!this.destroyRef.destroyed) this.busy.set(false);
    }
  }
}
