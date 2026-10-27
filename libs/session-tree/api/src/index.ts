// Public API of @pi-kit/session-tree/api (`type:api`, `scope:session-tree`): what the chat and the shell use of the session tree: `GraphStore`.
// `export *` of `session-tree/data` rather than a list of names: a named re-export clause keeps the module of every listed name in the bundle of whoever imports the barrel (doc/docs/structure.md).
export * from '@pi-kit/session-tree/data';
