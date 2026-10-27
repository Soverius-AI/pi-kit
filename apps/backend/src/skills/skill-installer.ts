import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { InstallSkill, SkillDetail } from '@pi-kit/protocol';
import { parseDocument } from 'yaml';
import { DEFAULT_SKILLS_CONFIG, type SkillsConfig } from '../app/config';
import { run } from '../worktree/worktree-git';

export class SkillInstallConflict extends Error {}

export const INSTALL_METADATA = '.pi-kit-source.json';
const MAX_FILES = 10000;
const MAX_BYTES = 100 * 1024 * 1024; // Selected skill payload, not the whole collection.
const MAX_REPOSITORY_BYTES = 1024 * 1024 * 1024;
const MAX_DEPTH = 10;
const activeDestinations = new Set<string>();

export function canonicalSkillSource(source: string): string {
  const match = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/.exec(
    source,
  );
  if (!match) throw new Error('Source must be a public GitHub owner/repository or HTTPS repository URL');
  const repo = match[2].replace(/\.git$/, '');
  if (!repo || repo === '.' || repo === '..') throw new Error('Invalid GitHub repository');
  return `https://github.com/${match[1]}/${repo}.git`;
}

function validName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  author?: string;
  warnings: string[];
}

export function parseSkillManifest(text: string): SkillManifest {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) throw new Error('SKILL.md requires YAML frontmatter');
  const doc = parseDocument(frontmatter[1], { uniqueKeys: true });
  if (doc.errors.length) throw new Error('Invalid skill YAML frontmatter');
  const data = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown> | null;
  if (!data || typeof data['name'] !== 'string' || !validName(data['name'])) throw new Error('Invalid skill name');
  if (typeof data['description'] !== 'string' || !data['description'].trim() || data['description'].length > 1024)
    throw new Error('Invalid skill description (1–1024 characters required)');
  const warnings: string[] = [];
  const optionalText = (value: unknown, label: string, limit: number): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > limit) {
      warnings.push(`Invalid ${label} metadata was omitted.`);
      return undefined;
    }
    return value;
  };
  const metadata = data['metadata'];
  const author =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? optionalText((metadata as Record<string, unknown>)['author'], 'author', 256)
      : undefined;
  if (['context', 'hooks', 'allowed-tools'].some((key) => Object.hasOwn(data, key)))
    warnings.push(
      'Frontmatter includes environment/tool-specific settings (context, hooks or allowed-tools); support depends on the agent and these settings are not verified.',
    );
  return {
    name: data['name'],
    description: data['description'],
    license: optionalText(data['license'], 'license', 1024),
    compatibility: optionalText(data['compatibility'], 'compatibility', 1024),
    author,
    warnings,
  };
}

/** Walk without following links, bounding both repository discovery and the complete copied payload. */
async function inventory(root: string, maxBytes = MAX_BYTES): Promise<string[]> {
  const files: string[] = [];
  let bytes = 0;
  let entries = 0;
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error('Repository directory depth limit exceeded');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      if (++entries > MAX_FILES) throw new Error('Repository file count limit exceeded');
      const path = join(dir, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error('Repository contains unsafe links or special files');
      if (stat.isDirectory()) await visit(path, depth + 1);
      else {
        bytes += stat.size;
        if (bytes > maxBytes)
          throw new Error(
            maxBytes === MAX_BYTES
              ? 'Selected skill exceeds the 100 MB size limit'
              : 'Repository exceeds the 1 GB size limit',
          );
        files.push(relative(root, path));
      }
    }
  }
  await visit(root, 0);
  return files;
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new SkillInstallConflict('Skill destination already exists');
}

/** Supplied bases are trusted/canonicalized; managed children must never be symlinks. */
async function safeDirectory(base: string, parts: readonly string[]): Promise<void> {
  let absolute = base;
  for (const part of parts) {
    absolute = join(absolute, part);
    try {
      await mkdir(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe destination ancestor');
  }
}

interface FetchedSkill {
  repo: string;
  selected: string;
  selectedRoot: string;
  payload: string[];
  licenses: string[];
  commit: string;
}

async function withFetchedSkill<T>(
  input: { source: string; name: string; commit?: string },
  use: (skill: FetchedSkill) => Promise<T>,
  config: SkillsConfig,
): Promise<T> {
  const source = canonicalSkillSource(input.source);
  if (!validName(input.name)) throw new Error('Invalid selected skill name');
  if (input.commit !== undefined && !/^[a-f0-9]{40,64}$/.test(input.commit))
    throw new Error('Invalid requested commit');
  const temp = await mkdtemp(join(tmpdir(), 'pi-skill-fetch-'));
  try {
    const repo = join(temp, 'repo');
    // Do not inherit Git config, credentials, filters, or alternate object paths.
    const env: Record<string, string> = {};
    for (const key of Object.keys(process.env))
      if (/^GIT_|^SSH_|^GCM_/.test(key)) env[key] = undefined as unknown as string;
    Object.assign(env, {
      HOME: temp,
      XDG_CONFIG_HOME: temp,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
      SSH_ASKPASS: '/bin/false',
      GCM_INTERACTIVE: 'never',
      GIT_LFS_SKIP_SMUDGE: '1',
    });
    const gitConfig = [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'init.templateDir=',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'http.followRedirects=false',
      '-c',
      'submodule.recurse=false',
      '-c',
      'core.attributesFile=/dev/null',
    ];
    const git = async (cwd: string, args: string[]): Promise<string> => {
      const result = await run(cwd, [...gitConfig, ...args], { timeoutMs: config.gitTimeoutMs, env });
      if (!result.ok) throw new Error('Unable to fetch public GitHub skill repository');
      return result.stdout;
    };
    await git(temp, ['clone', '--depth=1', '--single-branch', '--no-tags', '--no-checkout', '--', source, repo]);
    // Bound the downloaded object store before materializing it. The fetch itself is time-bounded;
    // git offers no hard downloaded-byte quota without an OS-level filesystem quota.
    await inventory(join(repo, '.git'), MAX_REPOSITORY_BYTES);
    let commit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    if (input.commit && commit !== input.commit) {
      await git(repo, ['fetch', '--depth=1', '--no-tags', '--', source, input.commit]);
      commit = (await git(repo, ['rev-parse', 'FETCH_HEAD'])).trim();
      if (commit !== input.commit) throw new Error('Fetched commit does not match requested commit');
      await inventory(join(repo, '.git'), MAX_REPOSITORY_BYTES);
    }
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid repository commit');
    const tree = (await git(repo, ['ls-tree', '-r', '-l', '-z', commit])).split('\0').filter(Boolean);
    let total = 0;
    if (tree.length > MAX_FILES) throw new Error('Repository file count limit exceeded');
    for (const entry of tree) {
      const match = /^(\d+) blob [a-f0-9]+\s+(\d+)\t([\s\S]+)$/.exec(entry);
      if (!match || !['100644', '100755'].includes(match[1]))
        throw new Error('Repository contains unsafe links or submodules');
      const parts = match[3].split('/');
      if (
        parts.length > MAX_DEPTH ||
        parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git' || p.includes('\\'))
      )
        throw new Error('Unsafe repository path');
      total += Number(match[2]);
      if (total > MAX_REPOSITORY_BYTES) throw new Error('Repository exceeds the 1 GB size limit');
    }
    await git(repo, ['checkout', '--force', '--detach', commit]);
    const files = await inventory(repo, MAX_REPOSITORY_BYTES);
    const candidates: string[] = [];
    for (const file of files.filter((f) => basename(f) === 'SKILL.md')) {
      const folder = dirname(file);
      if ((await lstat(join(repo, file))).size > 256 * 1024) {
        if (basename(folder) === input.name) throw new Error('Selected SKILL.md too large');
        continue;
      }
      const text = await readFile(join(repo, file), 'utf8');
      let manifest: ReturnType<typeof parseSkillManifest>;
      try {
        manifest = parseSkillManifest(text);
      } catch (error) {
        // Collections may contain unrelated broken manifests and example templates.
        const declaresSelected = new RegExp(`^name:\\s*['"]?${input.name}['"]?\\s*$`, 'm').test(text);
        if (basename(folder) === input.name || declaresSelected) {
          throw new Error(`Selected skill has invalid manifest: ${(error as Error).message}`, { cause: error });
        }
        continue;
      }
      if (manifest.name === input.name) {
        if (folder !== '.' && basename(folder) !== manifest.name) throw new Error('Skill name must match its folder');
        candidates.push(folder);
      }
    }
    if (candidates.length > 1) throw new SkillInstallConflict('Selected skill is ambiguous');
    if (!candidates.length) throw new Error('Selected skill not found');
    const selected = candidates[0];
    const selectedRoot = join(repo, selected);
    const payload = await inventory(selectedRoot);
    if (payload.includes(INSTALL_METADATA)) throw new Error('Repository uses reserved installer metadata filename');
    const licenses =
      selected === '.'
        ? []
        : files.filter(
            (f) => dirname(f) === '.' && /^(license|licence|copying|notice)([.-].*)?$/i.test(f) && !payload.includes(f),
          );
    return await use({ repo, selected, selectedRoot, payload, licenses, commit });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const previewCache = new Map<string, { expires: number; pending: boolean; result: Promise<SkillDetail> }>();
const previewWaiters: Array<() => void> = [];
let activePreviews = 0;

export async function previewSkill(
  input: { source: string; name: string },
  options?: Partial<SkillsConfig>,
): Promise<SkillDetail> {
  const config = { ...DEFAULT_SKILLS_CONFIG, ...options };
  const source = canonicalSkillSource(input.source);
  if (!validName(input.name)) throw new Error('Invalid selected skill name');
  const key = `${source}:${input.name}:${JSON.stringify(config)}`;
  const now = Date.now();
  for (const [cachedKey, entry] of previewCache)
    if (!entry.pending && entry.expires <= now) previewCache.delete(cachedKey);
  const cached = previewCache.get(key);
  if (cached) return structuredClone(await cached.result);
  while (previewCache.size >= config.previewCacheEntries) {
    const evict = [...previewCache].find(([, entry]) => !entry.pending);
    if (!evict) throw new Error('Too many skill previews in progress; try again shortly');
    previewCache.delete(evict[0]);
  }
  const result = (async () => {
    if (activePreviews >= config.previewConcurrency) await new Promise<void>((ready) => previewWaiters.push(ready));
    else activePreviews++;
    try {
      return await withFetchedSkill(
        input,
        async ({ repo, selected, selectedRoot, payload, licenses, commit }) => {
          const text = await readFile(join(selectedRoot, 'SKILL.md'), 'utf8');
          const manifest = parseSkillManifest(text);
          const warnings = [...manifest.warnings];
          if (text.length > 40000) warnings.push('SKILL.md preview was truncated to 40,000 characters.');
          const allScripts = payload.filter((file) => file.split(sep)[0] === 'scripts').sort();
          if (allScripts.length > 20) warnings.push('Script listing was truncated to 20 files.');
          let bytes = 0;
          for (const file of payload) bytes += (await lstat(join(selectedRoot, file))).size;
          for (const file of licenses) bytes += (await lstat(join(repo, file))).size;
          return {
            source: source.slice('https://github.com/'.length, -4),
            name: manifest.name,
            description: manifest.description,
            license: manifest.license,
            compatibility: manifest.compatibility,
            author: manifest.author,
            path: selected.split(sep).join('/'),
            commit,
            files: payload.length + licenses.length,
            bytes,
            scripts: allScripts.slice(0, 20).map((file) => file.split(sep).join('/')),
            content: text.slice(0, 40000),
            warnings,
          };
        },
        config,
      );
    } finally {
      const next = previewWaiters.shift();
      if (next) next();
      else activePreviews--;
    }
  })();
  const entry = { expires: now + config.previewCacheMs, pending: true, result };
  previewCache.set(key, entry);
  try {
    const detail = await result;
    entry.pending = false;
    entry.expires = Date.now() + config.previewCacheMs;
    return structuredClone(detail);
  } catch (error) {
    previewCache.delete(key);
    throw error;
  }
}

export async function installSkill(
  input: InstallSkill & { agentDir: string; cwd: string },
  options?: Partial<SkillsConfig>,
): Promise<void> {
  const config = { ...DEFAULT_SKILLS_CONFIG, ...options };
  const source = canonicalSkillSource(input.source);
  if (!validName(input.name)) throw new Error('Invalid selected skill name');
  if (input.commit !== undefined && !/^[a-f0-9]{40,64}$/.test(input.commit))
    throw new Error('Invalid requested commit');
  if (input.scope !== 'user' && input.scope !== 'project') throw new Error('Invalid skill scope');
  const suppliedBase = resolve(input.scope === 'user' ? input.agentDir : input.cwd);
  await mkdir(suppliedBase, { recursive: true });
  const base = await realpath(suppliedBase);
  const managedParts = input.scope === 'user' ? ['skills'] : ['.pi', 'skills'];
  const root = join(base, ...managedParts);
  const destination = join(root, input.name);
  if (activeDestinations.has(destination)) throw new SkillInstallConflict('Skill installation already in progress');
  activeDestinations.add(destination);
  let stage: string | undefined;
  try {
    await safeDirectory(base, managedParts);
    await assertAbsent(destination);
    await withFetchedSkill(
      input,
      async ({ repo, selected, selectedRoot, payload, licenses, commit }) => {
        stage = await mkdtemp(join(root, '.install-'));
        for (const file of payload) {
          await mkdir(dirname(join(stage, file)), { recursive: true });
          await copyFile(join(selectedRoot, file), join(stage, file), constants.COPYFILE_EXCL);
        }
        for (const file of licenses) await copyFile(join(repo, file), join(stage, file), constants.COPYFILE_EXCL);
        await writeFile(
          join(stage, INSTALL_METADATA),
          JSON.stringify({ source, commit, path: selected.split(sep).join('/') }, null, 2) + '\n',
          { flag: 'wx' },
        );
        await safeDirectory(base, managedParts);
        // The reservation is process-local; unrelated filesystem writers can still race placement.
        await assertAbsent(destination);
        await rename(stage, destination);
        stage = undefined;
      },
      config,
    );
  } finally {
    activeDestinations.delete(destination);
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
