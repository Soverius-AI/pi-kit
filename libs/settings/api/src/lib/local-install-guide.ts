import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { LocalHardware } from '@pi-kit/protocol';

@Component({
  selector: 'pk-local-install-guide',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (guide(); as help) {
      <details class="rounded-xl border border-base-300 p-4" [open]="!installed()">
        <summary class="font-medium cursor-pointer">{{ 'settings.installGuide.title' | transloco }}</summary>
        <div class="flex flex-col gap-3 mt-3">
          <p class="t-sm m-0">{{ 'settings.installGuide.safety' | transloco }}</p>
          @if (help.manager === 'brew') {
            <p class="t-sm m-0">{{ 'settings.installGuide.brew' | transloco }}</p>
            <a class="link t-sm" href="https://brew.sh" target="_blank" rel="noopener noreferrer">{{
              'settings.installGuide.brewLink' | transloco
            }}</a>
          } @else {
            <p class="t-sm m-0">
              {{ (help.manager === 'apt' ? 'settings.installGuide.apt' : 'settings.installGuide.manual') | transloco }}
            </p>
            @if (help.prerequisites) {
              <b class="t-sm">{{ 'settings.installGuide.prerequisites' | transloco }}</b>
              <pre class="t-xs overflow-x-auto rounded-lg bg-base-200 p-3 select-text">{{ help.prerequisites }}</pre>
            }
            <label class="t-sm flex flex-col gap-1"
              >{{ 'settings.installGuide.backend' | transloco }}
              <select class="select select-bordered w-full" [value]="backend()" (change)="selectBackend($event)">
                <option value="cpu">{{ 'settings.installGuide.cpuLabel' | transloco }}</option>
                <option value="cuda">{{ 'settings.installGuide.cudaLabel' | transloco }}</option>
                <option value="vulkan">{{ 'settings.installGuide.vulkanLabel' | transloco }}</option>
              </select>
            </label>
            <p class="t-sm muted m-0">{{ 'settings.installGuide.' + backend() | transloco }}</p>
            @if (backend() === 'cuda') {
              <a
                class="link t-sm"
                href="https://developer.nvidia.com/cuda-downloads"
                target="_blank"
                rel="noopener noreferrer"
                >{{ 'settings.installGuide.cudaLink' | transloco }}</a
              >
            }
            <p class="t-sm m-0">{{ 'settings.installGuide.source' | transloco }}</p>
            @for (build of help.builds; track build.id) {
              @if (build.id === backend()) {
                <pre class="t-xs overflow-x-auto rounded-lg bg-base-200 p-3 select-text">{{ build.command }}</pre>
              }
            }
            <a
              class="link t-sm"
              href="https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md"
              target="_blank"
              rel="noopener noreferrer"
              >{{ 'settings.installGuide.buildDocs' | transloco }}</a
            >
            <b class="t-sm">{{ 'settings.installGuide.swapLabel' | transloco }}</b>
            <p class="t-sm m-0">{{ 'settings.installGuide.swap' | transloco }}</p>
            <a
              class="link t-sm"
              href="https://github.com/mostlygeek/llama-swap/releases"
              target="_blank"
              rel="noopener noreferrer"
              >{{ 'settings.installGuide.swapLink' | transloco }}</a
            >
            <pre class="t-xs overflow-x-auto rounded-lg bg-base-200 p-3 select-text">{{ help.swapCommand }}</pre>
            <p class="t-sm m-0">{{ 'settings.installGuide.verify' | transloco }}</p>
          }
        </div>
      </details>
    }
  `,
})
export class LocalInstallGuide {
  readonly guide = input<LocalHardware['installer']['guide']>();
  readonly installed = input(false);
  protected readonly backend = signal('cpu');
  protected selectBackend(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (['cpu', 'cuda', 'vulkan'].includes(value)) this.backend.set(value);
  }
}
