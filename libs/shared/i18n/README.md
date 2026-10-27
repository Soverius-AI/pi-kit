# Interface localization

Transloco 8.4.0 provides English (`en`, the default) and German (`de`).
`provideLanguage()` loads the selected JSON asset before the first render. Angular copies
`src/lib/translations/*.json` to the renderer’s `i18n/` directory, including desktop builds.
German number/date locale data is loaded on demand.
The desktop tray receives its translated labels from the renderer through `PiKitBridge`.

Settings → General → Language writes through `ViewPrefs`: SQLite is authoritative and
`pi-kit.look` caches the preference for the next first paint. The current interface remains
usable during a download or failure. Failed loads can be retried; the latest language choice wins.

Use `TranslocoPipe` for template messages and `Language.t` inside computed labels, methods,
and store features. Pure presentation helpers take a `Translate` function explicitly, so
metadata and settings search react to language changes without Angular dependencies in the helpers.
User messages, model responses, file/code contents, tool/console output, and external diagnostic
text retain their original content. Localize app-owned state labels around that content.

Store catalogs as nested JSON objects (for example, `settings.language.name` lives at
`{ "settings": { "language": { "name": "Interface language" } } }`). Continue using dotted
lookup paths in templates and TypeScript. Keep message keys descriptive and add the same
interpolation names to both catalogs. The checker rejects dotted property names in JSON.
`pnpm check:i18n` verifies catalog parity, parameters, literal references, and template copy.
The check runs in `pnpm check` and when catalog changes are committed. Tests use the real
catalogs through `@pi-kit/i18n/testing`; Angular projects inherit `src/test-providers.ts` and its cache inputs from `nx.json`.
