import { z } from 'zod';

/**
 * Pi packages in Settings › Extensions and skills: what is installed (`pi install`), what each brings, and the "Add a package" wizard's search and detail. pi owns
 * the installing and the format (docs/packages.md); these are the shapes of pi-kit's routes over pi's package manager.
 */

export const PACKAGE_KINDS = ['extensions', 'skills', 'prompts', 'themes'] as const;
export const PackageKindSchema = z.enum(PACKAGE_KINDS);
export type PackageKind = z.infer<typeof PackageKindSchema>;

/** Where a package comes from: npm, a git repository, a folder on this machine, or one that ships with pi-kit. */
export const PackageOriginSchema = z.enum(['npm', 'git', 'folder', 'bundled']);
export type PackageOrigin = z.infer<typeof PackageOriginSchema>;

/** What a package adds: how many of each, and the first names of each (for the row's tooltip and the wizard's "What it adds"). */
export const PackageBringsSchema = z
  .object({
    extensions: z.number().int(),
    skills: z.number().int(),
    prompts: z.number().int(),
    themes: z.number().int(),
    names: z.object({
      extensions: z.array(z.string()),
      skills: z.array(z.string()),
      prompts: z.array(z.string()),
      themes: z.array(z.string()),
    }),
  })
  .meta({ id: 'PackageBrings' });
export type PackageBrings = z.infer<typeof PackageBringsSchema>;

export const PackageOutdatedSchema = z
  .object({ current: z.string().optional(), latest: z.string().optional() })
  .meta({ id: 'PackageOutdated' });
export type PackageOutdated = z.infer<typeof PackageOutdatedSchema>;

export const PackageItemSchema = z
  .object({
    /** `<scope>:<source>`; the route parameter, URL-encoded. */
    id: z.string(),
    /** As pi's settings file holds it: `npm:pi-subagents`, `git:github.com/x/y`, `/Users/me/pkg`. */
    source: z.string(),
    /** The package's own name (its `package.json`), or the last part of the source. */
    name: z.string(),
    version: z.string().optional(),
    description: z.string().optional(),
    scope: z.enum(['user', 'project']),
    origin: PackageOriginSchema,
    /** Off: pi keeps the entry and loads nothing of it (every resource type filtered to none). */
    enabled: z.boolean(),
    /** Installed on disk. False: pi's settings name it, nothing is there (an install that was cut short, a folder that moved). */
    installed: z.boolean(),
    path: z.string().optional(),
    /** When it was installed, ms (npm and git; a folder is not copied). */
    installedAt: z.number().optional(),
    brings: PackageBringsSchema,
    /** Set by a check for updates. */
    outdated: PackageOutdatedSchema.optional(),
  })
  .meta({ id: 'PackageItem' });
export type PackageItem = z.infer<typeof PackageItemSchema>;

export const PackagesOverviewSchema = z
  .object({
    packages: z.array(PackageItemSchema),
    /** When the last check for updates finished (ms). */
    checkedAt: z.number().optional(),
    errors: z.array(z.string()),
  })
  .meta({ id: 'PackagesOverview' });
export type PackagesOverview = z.infer<typeof PackagesOverviewSchema>;

/** A source `pi install` takes: `npm:name[@version]`, `git:host/path[@ref]`, an https or ssh repository URL, or a folder. */
export const PackageSourceSchema = z.string().trim().min(1).max(1000);

export const InstallPackageSchema = z
  .object({
    source: PackageSourceSchema,
    /** `user` (every project, the default) or `project` (this folder's `.pi/settings.json`, a trusted folder). */
    scope: z.enum(['user', 'project']).optional(),
  })
  .strict()
  .meta({ id: 'InstallPackage' });
export type InstallPackage = z.infer<typeof InstallPackageSchema>;

export const PackageEnabledRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict()
  .meta({ id: 'PackageEnabledRequest' });

/** What an install, an update or a removal answers with: the list afterwards, and a sentence for the toast. */
export const PackageActionResultSchema = z
  .object({ message: z.string(), overview: PackagesOverviewSchema, reloaded: z.number().int() })
  .meta({ id: 'PackageActionResult' });
export type PackageActionResult = z.infer<typeof PackageActionResultSchema>;

export const PackageSearchKindSchema = z.enum(['all', ...PACKAGE_KINDS]);
export type PackageSearchKind = z.infer<typeof PackageSearchKindSchema>;
export const PackageSearchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  kind: PackageSearchKindSchema.optional(),
});
export type PackageSearchQuery = z.infer<typeof PackageSearchQuerySchema>;

/** One result of the Browse tab: an npm package, or one of the two that ship with pi-kit. */
export const PackageSearchResultSchema = z
  .object({
    name: z.string(),
    /** What `pi install` takes for it. */
    source: z.string(),
    version: z.string(),
    description: z.string().optional(),
    /** Monthly downloads. */
    downloads: z.number().optional(),
    /** When the latest version was published (ISO). */
    updated: z.string().optional(),
    license: z.string().optional(),
    repository: z.string().optional(),
    author: z.string().optional(),
    /** What it contains, when the registry's metadata has the package's `pi` key; otherwise only what its keywords say. */
    contains: z.array(PackageKindSchema),
    /** `contains` is a count from the manifest (true) or a guess from keywords (false). */
    exact: z.boolean(),
    brings: z
      .object({
        extensions: z.number().int(),
        skills: z.number().int(),
        prompts: z.number().int(),
        themes: z.number().int(),
      })
      .optional(),
    bundled: z.boolean().optional(),
    /** Already in pi's settings. */
    installed: z.boolean().optional(),
  })
  .meta({ id: 'PackageSearchResult' });
export type PackageSearchResult = z.infer<typeof PackageSearchResultSchema>;

export const PackageSearchResponseSchema = z
  .object({
    results: z.array(PackageSearchResultSchema),
    /** Matches on the registry, which can be more than the 20 listed. */
    total: z.number().int(),
    /** Why the registry's results are missing (offline, slow, refused): the pi-kit packages are still listed. */
    error: z.string().optional(),
  })
  .meta({ id: 'PackageSearchResponse' });
export type PackageSearchResponse = z.infer<typeof PackageSearchResponseSchema>;

/** `GET /api/packages/detail?source=`: what the wizard's second step shows before anything is installed. */
export const PackageDetailQuerySchema = z.object({ source: PackageSourceSchema, cwd: z.string().optional() });
export const PackageDetailSchema = z
  .object({
    source: z.string(),
    origin: PackageOriginSchema,
    name: z.string(),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z.string().optional(),
    license: z.string().optional(),
    repository: z.string().optional(),
    downloads: z.number().optional(),
    updated: z.string().optional(),
    /** What it adds; absent when it cannot be known without installing (a git repository, a registry that omits the `pi` key). */
    brings: PackageBringsSchema.optional(),
    /** The README as plain text, cut at 40 000 characters. */
    readme: z.string().optional(),
    /** Why the README or the contents are missing. */
    notes: z.array(z.string()),
    /** The exact command pi-kit runs for this source, as typed in a terminal. */
    command: z.string(),
    /** Already installed in the scope. */
    installed: z.boolean(),
  })
  .meta({ id: 'PackageDetail' });
export type PackageDetail = z.infer<typeof PackageDetailSchema>;

// ---- skill files and catalog

export const SkillFileSchema = z
  .object({
    path: z.string(),
    text: z.string(),
    mtime: z.number(),
    /** The skill's folder name. */
    name: z.string(),
    scope: z.enum(['user', 'project']),
  })
  .meta({ id: 'SkillFile' });
export type SkillFile = z.infer<typeof SkillFileSchema>;

export const SkillFileQuerySchema = z.object({ path: z.string().min(1), cwd: z.string().optional() });
export const SkillSearchQuerySchema = z.object({ q: z.string().trim().min(2).max(200) });
export const SkillSearchResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    source: z.string(),
    installs: z.number().int().nonnegative(),
    url: z.string(),
  })
  .meta({ id: 'SkillSearchResult' });
export type SkillSearchResult = z.infer<typeof SkillSearchResultSchema>;
export const SkillSearchResponseSchema = z
  .object({ results: z.array(SkillSearchResultSchema), error: z.string().optional() })
  .meta({ id: 'SkillSearchResponse' });
export type SkillSearchResponse = z.infer<typeof SkillSearchResponseSchema>;
export const InstallSkillSchema = z
  .object({
    source: z.string().trim().min(1).max(300),
    name: z.string().min(1).max(64),
    scope: z.enum(['user', 'project']),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
  })
  .strict()
  .meta({ id: 'InstallSkill' });
export type InstallSkill = z.infer<typeof InstallSkillSchema>;
export const SkillDetailQuerySchema = z.object({
  source: z.string().trim().min(1).max(300),
  name: z.string().min(1).max(64),
});
export const SkillDetailSchema = z
  .object({
    source: z.string(),
    name: z.string(),
    description: z.string(),
    license: z.string().optional(),
    compatibility: z.string().optional(),
    author: z.string().optional(),
    path: z.string(),
    commit: z.string(),
    files: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
    scripts: z.array(z.string()),
    content: z.string(),
    warnings: z.array(z.string()),
  })
  .meta({ id: 'SkillDetail' });
export type SkillDetail = z.infer<typeof SkillDetailSchema>;
export const DeleteSkillSchema = z.object({ mtime: z.number().nonnegative() }).strict().meta({ id: 'DeleteSkill' });
export const SkillActionResultSchema = z
  .object({ message: z.string(), reloaded: z.number().int().nonnegative() })
  .meta({ id: 'SkillActionResult' });
export type SkillActionResult = z.infer<typeof SkillActionResultSchema>;

// ---- helpers the renderer and the backend share

/** The origin a source string names (`npm:`, a git URL, a folder); `bundled` is decided by the backend from what is installed. */
export function originOfSource(source: string): Exclude<PackageOrigin, 'bundled'> {
  const s = source.trim();
  if (s.startsWith('npm:')) return 'npm';
  if (/^(git:|git\+|https?:\/\/|ssh:\/\/|git@)/.test(s)) return 'git';
  return 'folder';
}

/** The command `pi install` takes for the source and scope, as the wizard's last line says it. */
export function installCommand(source: string, scope: 'user' | 'project' = 'user'): string {
  const quoted = /[\s"'$`\\]/.test(source) ? `'${source.replace(/'/g, `'\\''`)}'` : source;
  return `pi install ${scope === 'project' ? '-l ' : ''}${quoted}`;
}

/** "1 extension, 2 skills": the nonzero kinds, singular where it is one; "nothing" for a package that brings none. */
export function bringsText(brings: Pick<PackageBrings, PackageKind>): string {
  const word: Record<PackageKind, [string, string]> = {
    extensions: ['extension', 'extensions'],
    skills: ['skill', 'skills'],
    prompts: ['prompt', 'prompts'],
    themes: ['theme', 'themes'],
  };
  const parts = PACKAGE_KINDS.filter((k) => brings[k] > 0).map(
    (k) => `${brings[k]} ${word[k][brings[k] === 1 ? 0 : 1]}`,
  );
  return parts.length > 0 ? parts.join(', ') : 'nothing yet';
}
