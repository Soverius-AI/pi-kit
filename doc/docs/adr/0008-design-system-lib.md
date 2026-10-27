# ADR-0008: A minimal design system library ships six stylesheets

Status: Accepted
Date: 2026-10-15

## Context

Several places render UI: the renderer, `libs/ui` and the generative-UI renderers. Built ad hoc
from daisyUI defaults they do not share spacing, radii, type or layout rules, and the result is
inconsistent and not responsive. The rules need one home that all Angular code consumes. A single
seed stylesheet holding themes, the shell grid and every `pk-*` component rule does not scale, and
the font `@import` only works as the first stylesheet, so the library needs a defined file set and
one consumer.

## Decision

- `libs/design-system` is the design system. `docs/design-system.md` is the written spec; a change
  to a token is a change to that file first.
- `libs/design-system/src/` holds six stylesheets:

| File | Content |
|---|---|
| `fonts.css` | IBM Plex `@import`; must be the first stylesheet (an `@import` after other rules is ignored) |
| `tokens.css` | the two daisyUI 5 themes `pi-dark` / `pi-light`, app tokens (`--pk-space-*`, `--pk-text-*`, `--pk-measure`, `--pk-shadow`), base element styles |
| `icons.css` | icon styles |
| `layout.css` | shell grid, header/crumbs/transcript/composer frames, sidebar, breakpoints from `docs/design-system.md` |
| `components.css` | transcript, activity, composer, graph and review rules; rules move into Angular primitives over time |
| `preset.css` | Tailwind v4 `@theme` mapping the tokens to utilities (`text-prose`, `max-w-measure`, spacing steps) and the daisyUI plugin with `themes: false` |

- The renderer imports these files from the library by relative path. No copies or mirrors exist elsewhere.
- The library also holds Angular primitives with no app state: `pk-rail-button`, `pk-thread-row`, `pk-turn`,
  `pk-activity-row`, `pk-marker`, `pk-approval`, `pk-composer-well`, `pk-command-menu`,
  `pk-breadcrumb-strip`. The tree view stays in `libs/ui` because it has layout logic.
- No colour, radius or spacing value appears inline in app code; only tokens and daisyUI classes.

## Consequences

- The library exists before any screen is built; screens consume tokens, never define them.
- One stylesheet set, one consumer: a style change is a library change and nothing else.
- When a component's CSS moves into a primitive, its rules are deleted from `components.css`
  in the same change.
- Generative UI (A2UI catalog, MCP App frames) is themed by overriding its classes with the same
  tokens, so agent-rendered UI looks native.
- daisyUI's stock themes are not used; the two custom themes are the only ones registered.
