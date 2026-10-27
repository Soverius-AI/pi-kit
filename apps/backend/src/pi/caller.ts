import { basename, dirname } from 'node:path';

/**
 * Who called `ctx.ui.confirm / select / input / editor`? pi's `ExtensionUIContext` is one object shared by every extension and its
 * methods take no caller, so the question block could not say who asks. The call site can: an extension's frames in the stack
 * name its file (`.pi/extensions/git-guard.ts`, `~/.pi/agent/extensions/git-guard/index.ts`, a package's `extensions/` folder).
 * The extension's name is what pi-kit's settings list shows: the file name, or the folder for an `index` file.
 */
export function extensionNameFromStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  for (const line of stack.split('\n')) {
    const path = framePath(line);
    if (!path || path.includes('/node_modules/@earendil-works/') || !/(?:^|\/)extensions\//.test(path)) continue;
    const file = basename(path).replace(/\.(?:[cm]?[jt]s)$/, '');
    if (file !== 'index') return file;
    const folder = basename(dirname(path));
    return folder === 'extensions' ? file : folder;
  }
  return undefined;
}

/** The file of one `at ...` line of a V8 stack trace (without line and column), or undefined for a line that names none. */
function framePath(line: string): string | undefined {
  const match = /\(?((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^():]*?(?:\.[cm]?[jt]s))(?::\d+){0,2}\)?\s*$/.exec(line.trim());
  if (!match) return undefined;
  return match[1].replace(/^file:\/\//, '').replace(/\\/g, '/');
}
