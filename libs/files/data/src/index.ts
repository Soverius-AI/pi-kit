// Public API of @pi-kit/files/data (`type:data`, `scope:files`): the files store (folder listing, git decoration, editing, drag and drop). Nothing outside the domain reads it, so the domain has no `api`.
export * from './lib/files-policy';
export * from './lib/files.store';
