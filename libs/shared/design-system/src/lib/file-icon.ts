import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** The kinds of icon the Files panel tells files apart by. */
export type PkFileIconKind = 'folder' | 'folder-open' | 'code' | 'config' | 'markdown' | 'image' | 'lock' | 'file';

const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'sql',
  'html',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'lua',
  'dart',
  'ex',
  'exs',
]);
const CONFIG = new Set([
  'json',
  'jsonc',
  'yml',
  'yaml',
  'toml',
  'ini',
  'env',
  'conf',
  'cfg',
  'xml',
  'properties',
  'editorconfig',
]);
const MARKDOWN = new Set(['md', 'mdx', 'markdown', 'txt', 'rst']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
const LOCK_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'poetry.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
  'bun.lockb',
  'bun.lock',
]);
const CONFIG_NAMES = new Set([
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.eslintrc',
  'dockerfile',
  'makefile',
  '.dockerignore',
  '.env',
]);

/** Which icon a file or folder gets, from its name. */
export function fileIconKind(name: string, dir: boolean, open = false): PkFileIconKind {
  if (dir) return open ? 'folder-open' : 'folder';
  const lower = name.toLowerCase();
  if (LOCK_NAMES.has(lower) || lower.endsWith('.lock')) return 'lock';
  if (CONFIG_NAMES.has(lower) || lower.startsWith('.env') || /^tsconfig.*\.json$/.test(lower)) return 'config';
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (CODE.has(ext)) return 'code';
  if (CONFIG.has(ext)) return 'config';
  if (MARKDOWN.has(ext)) return 'markdown';
  if (IMAGE.has(ext)) return 'image';
  return 'file';
}

/** A 16px icon of the design system per kind (`file-<kind>`, `file-plain` for a plain file), tinted by kind in the stylesheet. */
@Component({
  selector: 'pk-file-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': '"pk-icon pk-ico " + kind()',
    '[style.--icon]': '"var(--pk-icon-file-" + (kind() === "file" ? "plain" : kind()) + ")"',
    'aria-hidden': 'true',
  },
  template: '',
})
export class PkFileIcon {
  readonly kind = input.required<PkFileIconKind>();
}
