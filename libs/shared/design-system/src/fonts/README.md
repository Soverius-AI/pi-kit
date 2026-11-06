# Theme fonts

The CopilotKit-inspired theme uses Plus Jakarta Sans (UI/prose, weights 200–800)
and Spline Sans Mono (code, weights 400–700). Both are bundled locally so this
theme does not require a network connection. The standard themes retain their fonts.

Unmodified variable WOFF2 files were obtained from CopilotKit's public website:

- Plus Jakarta Sans: https://www.copilotkit.ai/_next/static/media/cbd3c16fb126b740-s.p.woff2
- Spline Sans Mono: https://www.copilotkit.ai/_next/static/media/9f73a3ab7cc397fe-s.p.woff2

Both fonts are distributed under the SIL Open Font License 1.1; the accompanying
license files were obtained from the upstream Google Fonts directories:

- https://github.com/google/fonts/tree/main/ofl/plusjakartasans
- https://github.com/google/fonts/tree/main/ofl/splinesansmono

## Omarchy-inspired skin

`pi-omarchy` follows the approved Last Horizon mono-first mock. JetBrains Mono is
used for all UI, prose, user messages and code (normal and italic, variable weights
100–800). Both theme font tokens use the same monospace stack, with no separate prose
family. These theme-scoped fonts do not replace the standard themes' fonts. Four
Latin and Latin Extended subsets are bundled locally and use `font-display: swap`,
so this skin needs no external font request. Its `@font-face` declarations live in
`../omarchy.css` alongside the palette and skin rules; the font binaries and licenses
remain here with the other bundled fonts.

The following unmodified variable WOFF2 assets were fetched from
`https://de.omarchy.org/_astro/` (the identifiers are the website's asset hashes):

| Local file                              | Upstream asset identifier                        |
| --------------------------------------- | ------------------------------------------------ |
| `jetbrains-mono-latin.woff2`            | JetBrains Mono normal Latin, `B9CIFXIH`          |
| `jetbrains-mono-latin-ext.woff2`        | JetBrains Mono normal Latin Extended, `DBQx-q_a` |
| `jetbrains-mono-latin-italic.woff2`     | JetBrains Mono italic Latin, `B2M6KQje`          |
| `jetbrains-mono-latin-ext-italic.woff2` | JetBrains Mono italic Latin Extended, `BrDczivE` |

JetBrains Mono is distributed under SIL Open Font License 1.1. The accompanying
`JetBrainsMono-OFL.txt` was obtained from upstream Google Fonts:

- https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/OFL.txt

The Last Horizon palette uses warm near-black surfaces and a dusty rose primary,
not the Omarchy website's Tokyo Night/green palette. It changes paint and typography,
not component geometry.

These are brand-inspired pi-kit themes, not official or endorsed brand products.
