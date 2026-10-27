import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { LocalDoctorIssue } from '@pi-kit/protocol';
import { isMap, isScalar, type Document } from 'yaml';
import { modelCommandInfo } from './local-model-options';

/**
 * What keeps the selected llama-swap config from running: a model whose file is gone (an unmounted
 * volume, a deleted download), a launcher that no longer exists (a reinstalled llama.cpp), no models at all. Pure reads; `repair`
 * only touches what an issue names and keeps every other line of the user's YAML.
 */
export async function inspectModels(document: Document, options: { llamaServer?: string }): Promise<LocalDoctorIssue[]> {
  const issues: LocalDoctorIssue[] = [];
  const models = document.get('models', true);
  const names = isMap(models) ? models.items.map((item) => String(isScalar(item.key) ? item.key.value : item.key)) : [];
  if (names.length === 0) issues.push({ kind: 'no-models', detail: 'The config has no models. Add one in Your models (Add to llama-swap) or download one.', fixable: false });
  for (const name of names) {
    let info: ReturnType<typeof modelCommandInfo>;
    try { info = modelCommandInfo(document, name); } catch { continue; }
    if (info.modelPath && isAbsolute(info.modelPath) && !info.modelPath.includes('${') && !(await exists(info.modelPath))) {
      issues.push({ kind: 'missing-file', model: name, detail: `${name}: its model file is missing (${info.modelPath}). Repair removes the entry; the file is not touched.`, fixable: true });
      continue;
    }
    if (info.executable && isAbsolute(info.executable) && !info.executable.includes('${') && !(await exists(info.executable))) {
      const fixable = !!options.llamaServer && /llama-server$/.test(info.executable);
      issues.push({ kind: 'missing-launcher', model: name, detail: `${name}: its launcher is missing (${info.executable}).${fixable ? ` Repair points it at ${options.llamaServer}.` : ' Edit the command in Advanced YAML.'}`, fixable });
    }
  }
  return issues;
}

/** Applies the fixable issues to the document in place: missing-file entries go, missing launchers are replaced. Returns what changed. */
export function repairModels(document: Document, issues: LocalDoctorIssue[], llamaServer: string | undefined): string[] {
  const changes: string[] = [];
  const models = document.get('models', true);
  if (!isMap(models)) return changes;
  for (const issue of issues) {
    if (!issue.fixable || !issue.model) continue;
    if (issue.kind === 'missing-file') {
      if (models.delete(issue.model)) changes.push(`Removed ${issue.model} (its file is missing).`);
    } else if (issue.kind === 'missing-launcher' && llamaServer) {
      const entry = models.get(issue.model, true);
      if (!isMap(entry)) continue;
      const cmd = entry.get('cmd', true);
      if (!isScalar(cmd) || typeof cmd.value !== 'string') continue;
      const match = /^(\s*)('[^']*'|"[^"]*"|\S+)/.exec(cmd.value);
      if (!match) continue;
      cmd.value = `${match[1]}${quote(llamaServer)}${cmd.value.slice(match[0].length)}`;
      changes.push(`${issue.model} now starts ${llamaServer}.`);
    }
  }
  return changes;
}

const quote = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`;
const exists = (path: string): Promise<boolean> => stat(path).then((info) => info.isFile()).catch(() => false);
