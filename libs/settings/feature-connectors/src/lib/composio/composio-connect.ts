import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import { COMPOSIO_POPULAR_APPS, type ComposioApp } from '@pi-kit/protocol';
import { BrandLogosStore, ComposioStore, ConnectorsStore } from '@pi-kit/settings/api';
import { ComposioLogo } from './composio-logo';

interface Offer {
  toolkit: string;
  name: string;
  description?: string;
}

/** The apps reached through the Composio sign-in: search, the chosen apps with their state, and apps to add. */
@Component({
  selector: 'pk-composio-connect',
  imports: [ComposioLogo, PkIcon, PkTip, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './composio-connect.css',
  host: { 'data-testid': 'composio-connect' },
  template: `
    @if (store.connect(); as connect) {
      @if (!connect.server) {
        <div class="state" data-testid="composio-connect-missing">
          <span class="hint">{{ 'settings.composio.connectMissing' | transloco }}</span>
          <button type="button" class="btn btn-sm btn-primary" (click)="addComposio()">
            {{ 'settings.composio.addComposio' | transloco }}
          </button>
        </div>
      } @else if (!connect.signedIn) {
        <div class="state" data-testid="composio-connect-signin">
          <span class="hint">{{ connect.problem }}</span>
          <button type="button" class="btn btn-sm btn-primary" (click)="signIn(connect.server)">
            {{ 'settings.composio.connectSignIn' | transloco }}
          </button>
        </div>
      } @else {
        <form class="search" role="search" (submit)="$event.preventDefault(); searchComposio()">
          <pk-icon name="search" size="14" />
          <input
            type="search"
            [placeholder]="'settings.composio.searchPlaceholder' | transloco"
            [attr.aria-label]="'settings.composio.searchPlaceholder' | transloco"
            autocomplete="off"
            spellcheck="false"
            data-testid="composio-connect-search"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
          @if (store.searching()) {
            <span class="loading loading-spinner loading-xs"></span>
          }
        </form>
        @if (connect.problem) {
          <p class="hint text-error" role="alert">{{ connect.problem }}</p>
        }

        @if (connect.apps.length) {
          <h3>{{ 'settings.composio.yourApps' | transloco }}</h3>
          <ul class="mine" data-testid="composio-connect-apps">
            @for (app of connect.apps; track app.toolkit) {
              <li [attr.data-testid]="'composio-app-' + app.toolkit">
                <pk-composio-logo [toolkit]="app.toolkit" [name]="app.name" />
                <span class="name">{{ app.name }}</span>
                @if (app.connected) {
                  <span class="chip ok">{{ 'settings.composio.connected' | transloco }}</span>
                } @else if (app.error) {
                  <span class="hint err">{{ app.error }}</span>
                }
                <span class="actions">
                  @if (!app.connected) {
                    @if (app.signInUrl) {
                      <a
                        class="btn btn-xs btn-primary"
                        [href]="app.signInUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                        [pkTip]="'settings.composio.linkExpires' | transloco"
                        [attr.data-testid]="'composio-open-' + app.toolkit"
                        >{{ 'settings.composio.openConnect' | transloco: { value1: app.name } }}</a
                      >
                    } @else {
                      <button
                        type="button"
                        class="btn btn-xs btn-primary"
                        [disabled]="store.loading()"
                        [attr.data-testid]="'composio-connect-' + app.toolkit"
                        (click)="store.connectLink(app.toolkit)"
                      >
                        {{ 'settings.composio.connectApp' | transloco: { value1: app.name } }}
                      </button>
                    }
                    <button
                      type="button"
                      class="btn btn-xs btn-ghost btn-square"
                      [disabled]="store.loading()"
                      [pkTip]="'settings.composio.checkAgain' | transloco"
                      [attr.aria-label]="'settings.composio.checkAgain' | transloco"
                      (click)="store.loadConnect()"
                    >
                      <pk-icon name="refresh" size="14" />
                    </button>
                  }
                  <button
                    type="button"
                    class="btn btn-xs btn-ghost btn-square"
                    [disabled]="store.loading()"
                    [pkTip]="'settings.composio.removeN' | transloco: { value1: app.name }"
                    [attr.aria-label]="'settings.composio.removeN' | transloco: { value1: app.name }"
                    (click)="store.unwire(app.toolkit)"
                  >
                    <pk-icon name="trash" size="14" />
                  </button>
                </span>
              </li>
            }
          </ul>
        }

        <h3>{{ (query().trim() ? 'settings.composio.matches' : 'settings.composio.popular') | transloco }}</h3>
        <div class="grid" role="group" [attr.aria-label]="'settings.composio.chooseApps' | transloco">
          @for (app of offers(); track app.toolkit) {
            <button
              type="button"
              class="tile"
              [class.on]="chosen().has(app.toolkit)"
              [disabled]="chosen().has(app.toolkit) || store.loading()"
              [attr.data-testid]="'composio-popular-' + app.toolkit"
              [attr.title]="app.description || null"
              (click)="store.wire(app.toolkit, app.name)"
            >
              <pk-composio-logo [toolkit]="app.toolkit" [name]="app.name" />
              <span class="name">{{ app.name }}</span>
              <pk-icon [name]="chosen().has(app.toolkit) ? 'check' : 'plus'" size="14" />
            </button>
          } @empty {
            <p class="hint">{{ 'settings.composio.noMatches' | transloco }}</p>
          }
        </div>
        @if (query().trim() && store.found()?.query !== query().trim()) {
          <button
            type="button"
            class="btn btn-sm btn-ghost self-start"
            data-testid="composio-search-composio"
            [disabled]="store.searching()"
            (click)="searchComposio()"
          >
            <pk-icon name="search" size="14" />
            {{ 'settings.composio.searchComposio' | transloco: { value1: query().trim() } }}
          </button>
        }
      }
    } @else if (store.loading()) {
      <span class="loading loading-dots loading-sm"></span>
    }
  `,
})
export class ComposioConnect {
  protected readonly store = inject(ComposioStore);
  private readonly connectors = inject(ConnectorsStore);
  private readonly logos = inject(BrandLogosStore);
  protected readonly query = signal('');
  protected readonly chosen = computed(
    () => new Set((this.store.connect()?.apps ?? []).map((app: ComposioApp) => app.toolkit)),
  );
  /** The popular apps that match what is typed, then what Composio's search found for it. */
  protected readonly offers = computed<Offer[]>(() => {
    const query = this.query().trim().toLowerCase();
    const local = COMPOSIO_POPULAR_APPS.filter(
      (app) => !query || app.name.toLowerCase().includes(query) || app.toolkit.includes(query),
    );
    const found = this.store.found();
    const extra = found && query && found.query.toLowerCase() === query ? found.apps : [];
    const seen = new Set(local.map((app) => app.toolkit));
    return [...local, ...extra.filter((app) => !seen.has(app.toolkit))];
  });

  constructor() {
    effect(() => {
      const toolkits = [
        ...COMPOSIO_POPULAR_APPS.map((app) => app.toolkit),
        ...(this.store.connect()?.apps ?? []).map((app) => app.toolkit),
      ];
      untracked(() => void this.logos.load(toolkits));
    });
  }

  protected searchComposio(): void {
    void this.store.searchApps(this.query());
  }

  protected addComposio(): void {
    this.store.close();
    this.connectors.openWizard('composio');
  }

  protected signIn(server: string): void {
    this.store.close();
    void this.connectors.login(server);
  }
}
