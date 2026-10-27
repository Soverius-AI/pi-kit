# shared-design-system

The look of pi-kit as `doc/docs/design-system.md` describes it: the stylesheets the renderer imports (`fonts.css`, `preset.css`,
`tokens.css`, `icons.css`, `layout.css`, `components.css`), the icon sources in `src/icons` (built into `icons.css` and
`lib/icon-names.ts` by `pnpm run build:icons`), the brand marks in `src/brand`, and the presentational `pk-*` components and
directives (turn, activity row, approval, tooltip, graph row, list pages, code editor and the rest). The components hold no
app state and call no backend. Tags `scope:shared`, `type:ui`; alias `@pi-kit/design-system`.
