import { realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';
import type { LlamaRuntimeUpdates } from '@pi-kit/protocol';
import { localCommand, localExecutable } from './local-hardware.service';
import { modelCommandInfo } from './local-model-options';
import type { LocalLlamaSwapService } from './local-llama-swap.service';

const RELEASES = 'https://github.com/ggml-org/llama.cpp/releases';
let latest: { tag: string; at: number } | undefined;
let pending: Promise<void> | undefined;

/** Modern source builds can reset their build count (e.g. shallow clones); never compare those counts. */
export function runtimeUpdateStatus(
  version: string | undefined,
  tag: string,
): 'unknown' | 'update-available' | 'current' | 'newer-build' {
  if (!version) return 'unknown';
  const installed = /\bversion:\s*(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?/iu.exec(version);
  const released = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(tag);
  if (installed && released) {
    for (let i = 1; i <= 3; i++) {
      if (Number(installed[i]) < Number(released[i])) return 'update-available';
      if (Number(installed[i]) > Number(released[i])) return 'newer-build';
    }
    return installed[4] ? 'unknown' : 'current';
  }
  const legacy = /\bversion:\s*(\d+)\s*\(/iu.exec(version);
  if (legacy && /^b\d+$/u.test(tag))
    return Number(legacy[1]) < Number(tag.slice(1))
      ? 'update-available'
      : Number(legacy[1]) === Number(tag.slice(1))
        ? 'current'
        : 'newer-build';
  return 'unknown';
}

async function release(): Promise<void> {
  if (latest && Date.now() - latest.at < 15 * 60_000) return;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'pi-kit' },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Could not check GitHub releases. Try again later.');
    const body: unknown = await response.json();
    const tag = typeof body === 'object' && body !== null && 'tag_name' in body ? body.tag_name : undefined;
    if (typeof tag !== 'string' || !/^(?:b\d+|v\d+\.\d+\.\d+)$/u.test(tag))
      throw new Error('Latest release has an unrecognized build tag.');
    latest = { tag, at: Date.now() };
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

/** Explicit read-only check. No launcher shell is executed and no running model is restarted. */
export async function checkLlamaRuntimeUpdates(swap: LocalLlamaSwapService): Promise<LlamaRuntimeUpdates> {
  const runtimes = new Map<string, Set<string>>();
  for (const config of await swap.readConfigs()) {
    if (config.error) continue;
    const document = parseDocument((await swap.configFile(config.path)).text);
    for (const model of config.models) {
      try {
        const executable = modelCommandInfo(document, model).executable;
        if (!executable || !/^llama-server(?:\.exe)?$/u.test(basename(executable))) continue;
        const path = isAbsolute(executable)
          ? executable
          : executable === 'llama-server'
            ? await localExecutable(executable)
            : undefined;
        if (!path) continue;
        const canonical = await realpath(path).catch(() => path);
        const models = runtimes.get(canonical) ?? new Set<string>();
        models.add(model);
        runtimes.set(canonical, models);
      } catch {
        /* Unsupported launcher: do not guess or execute its shell. */
      }
    }
  }
  // Also show the default installation, clearly separated from configured model runtimes.
  const fallback = await localExecutable('llama-server');
  if (fallback) {
    const path = await realpath(fallback).catch(() => fallback);
    if (!runtimes.has(path)) runtimes.set(path, new Set());
  }
  let error: string | undefined;
  try {
    await release();
  } catch {
    error = 'Could not check the latest llama.cpp release. Installed builds are still shown; try again later.';
  }
  const entries: LlamaRuntimeUpdates['runtimes'] = [];
  for (const [path, models] of [...runtimes].slice(0, 24)) {
    let version: string | undefined;
    try {
      version = (await localCommand(path, ['--version'], 3000))
        .split('\n')
        .find((line) => /\bversion:/iu.test(line))
        ?.trim()
        .slice(0, 300);
    } catch {
      /* Missing/unreadable executable is unknown, not current. */
    }
    const packageVersion = /\/Cellar\/llama\.cpp\/(\d+\.\d+\.\d+)(?:_\d+)?\//u.exec(path)?.[1];
    const homebrew = !!packageVersion;
    // Some builds initialize GPU backends before --version and can time out while a model is loaded.
    if (!version && packageVersion)
      version = `version: ${packageVersion} (Homebrew package; executable version unavailable)`;
    entries.push({
      path,
      models: [...models],
      ...(version ? { version } : {}),
      source: homebrew ? 'Homebrew' : 'Custom / source build',
      status: error || !latest ? 'unknown' : runtimeUpdateStatus(version, latest.tag),
      guidance: homebrew
        ? 'Run brew update && brew upgrade llama.cpp, then check again. Stop affected models before upgrading.'
        : 'Update and rebuild the original llama.cpp checkout, or install an official release. Preserve custom patches and stop affected models first. Pi-kit will not replace this executable.',
    });
  }
  return {
    runtimes: entries,
    checkedAt: Date.now(),
    releasesUrl: RELEASES,
    ...(!error && latest ? { latest: latest.tag } : {}),
    ...(error ? { error } : {}),
  };
}
