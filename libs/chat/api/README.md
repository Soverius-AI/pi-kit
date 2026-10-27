# chat-api

`@pi-kit/chat/api`, library type `type:api` of the `chat` domain (tags `scope:chat`, `type:api`).

What other domains may import: an `export *` of `@pi-kit/chat/data` (`ChatStore`, `VoiceStore`, `CommandRegistry` and the chat's types). May use this domain's `data` and `util` and `scope:shared`.

The boundary rules are in `eslint.config.mjs` at the repository root; `doc/docs/structure.md` has the tree and the rule per type.
