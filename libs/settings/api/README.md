# settings-api

`@pi-kit/settings/api`, library type `type:api` of the `settings` domain (tags `scope:settings`, `type:api`).

What other domains may import: an `export *` of `@pi-kit/settings/data`, plus the onboarding's "Get a model" cards and the components that Settings and the onboarding share (the API-key and sign-in flows, the local runtime wizard, the file editor dialog, the setting row). May use this domain's `data` and `util` and `scope:shared`.

The boundary rules are in `eslint.config.mjs` at the repository root; `doc/docs/structure.md` has the tree and the rule per type.
