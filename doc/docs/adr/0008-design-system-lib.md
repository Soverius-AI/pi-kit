# ADR-0008: A shared design system supplies stylesheets and Angular primitives

Status: Accepted
Date: 2026-10-15

## Context

Several places render UI: the renderer, `libs/shared/ui` and the generative-UI renderers. Built ad hoc
from daisyUI defaults they do not share spacing, radii, type or layout rules, and the result is
inconsistent and not responsive. The rules need one home that all Angular code consumes. A single
seed stylesheet holding themes, the shell grid and every `pk-*` component rule does not scale, and
the font `@import` only works as the first stylesheet, so the library needs a defined file set and
one consumer.

## Decision

- `libs/shared/design-system` is the design system. `doc/docs/design-system.md` is the written spec; a change
  to a token is a change to that file first.
- `libs/shared/design-system/src/` holds the core stylesheets below, plus mobile and theme-specific styles:

| File | Content |
|---|---|
| `fonts.css` | IBM Plex `@import` and bundled font faces; must be the first stylesheet (an `@import` after other rules is ignored) |
| `tokens.css` | standard `pi-dark` / `pi-light` themes, named skins, app tokens (`--pk-space-*`, `--pk-text-*`, `--pk-measure`, `--pk-shadow`), base element styles |
| `omarchy.css` | the `pi-omarchy` (Last Horizon) skin: palette, fonts, motion and backdrop integration |
| `mobile.css` | mobile layout and interaction styles |
| `icons.css` | icon styles |
| `layout.css` | shell grid, header/crumbs/transcript/composer frames, sidebar, breakpoints from `doc/docs/design-system.md` |
| `components.css` | transcript, activity, composer, graph and review rules; shared component rules |
| `preset.css` | Tailwind v4 `@theme` mapping the tokens to utilities (`text-prose`, `max-w-measure`, spacing steps) and the daisyUI plugin with `themes: false` |

- The renderer imports these files from the library by relative path. No copies or mirrors exist elsewhere.
- The library also holds Angular primitives with no app state: `pk-rail-button`, `pk-thread-row`, `pk-turn`,
  `pk-activity-row`, `pk-marker`, `pk-approval`, `pk-composer-well`, `pk-command-menu`,
  `pk-breadcrumb-strip`. The tree view stays in `libs/shared/ui` because it has layout logic.
- Shared tokens and daisyUI classes define the common colour, radius and spacing vocabulary.

## Consequences

- One stylesheet set, one consumer: a style change is a library change and nothing else.
- Generative UI (A2UI catalog, MCP App frames) is themed by overriding its classes with the same
  tokens, so agent-rendered UI looks native.
- daisyUI's stock theme plugin is disabled. Standard themes, named skins and the desktop-derived
  `pi-desktop` palette share the app's token roles; the theme choices and integration are documented
  in `doc/docs/design-system.md`.
