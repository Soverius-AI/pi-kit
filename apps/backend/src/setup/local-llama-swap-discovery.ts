import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface DiscoveredLlamaSwapConfig { path: string; source: 'Running llama-swap' | 'Service configuration'; pid?: number; baseUrl?: string; watching?: boolean; }
const command = async (file: string, args: string[]): Promise<string> =>
  (await exec(file, args, { timeout: 2000, maxBuffer: 512_000, windowsHide: true })).stdout;

/** Read flags as data; never run or evaluate a service's command. Handles quoted and ps-unquoted paths with spaces. */
export function configFlags(commandLine: string, cwd?: string): { path: string; directory: boolean }[] {
  const matches = [...commandLine.matchAll(/(?:^|\s)--?(config-dir|config)(?:=|\s+)(.*?)(?=\s+--?[A-Za-z]|$)/g)];
  return matches.flatMap((match) => {
    let path = match[2].trim();
    if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
    path = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    if (!path || path.includes('\0') || (!isAbsolute(path) && !cwd)) return [];
    return [{ path: isAbsolute(path) ? path : resolve(cwd ?? '', path), directory: match[1] === 'config-dir' }];
  });
}

async function paths(flags: ReturnType<typeof configFlags>, source: DiscoveredLlamaSwapConfig['source']): Promise<DiscoveredLlamaSwapConfig[]> {
  return (await Promise.all(flags.map(async (flag) => {
    if (!flag.directory) return [{ path: flag.path, source }];
    const entries = await readdir(flag.path, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name)).slice(0, 128).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ path: join(flag.path, entry.name), source }));
  }))).flat();
}

/** Only the current process's listener is used for control; wildcard binds connect through loopback. */
export function processEndpoint(commandLine: string): string | undefined {
  const flag = (name: string): string | undefined => [...commandLine.matchAll(new RegExp(`(?:^|\\s)--?${name}(?:=|\\s+)("[^"]*"|'[^']*'|[^\\s]+)`, 'g'))].at(-1)?.[1].replace(/^['"]|['"]$/g, '');
  const tls = !!flag('tls-cert-file');
  let address = flag('listen') || (tls ? ':8443' : ':8080');
  if (address.startsWith(':')) address = `127.0.0.1${address}`;
  address = address.replace(/^0\.0\.0\.0:/, '127.0.0.1:').replace(/^\[::\]:/, '[::1]:');
  try {
    const url = new URL(`${tls ? 'https' : 'http'}://${address}`);
    return url.username || url.password || url.pathname !== '/' || !url.port ? undefined : url.origin;
  } catch { return undefined; }
}

async function running(): Promise<DiscoveredLlamaSwapConfig[]> {
  // Scratch desktop worlds must not discover or edit the user's real running service.
  if (process.env['NODE_ENV'] !== 'production' && process.env['PI_KIT_HOME']) return [];
  if (platform() === 'win32') {
    try {
      const result: unknown = JSON.parse(await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='llama-swap.exe'\" | Select-Object CommandLine | ConvertTo-Json -Compress"]));
      return (await Promise.all((Array.isArray(result) ? result : [result]).map((entry) => paths(configFlags(String(entry?.CommandLine ?? '')), 'Running llama-swap')))).flat();
    } catch { return []; }
  }
  const list = await command('ps', ['-A', '-o', 'pid=', '-o', 'comm=']).catch(() => '');
  const pids = list.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && basename(match[2].trim()) === 'llama-swap' ? [match[1]] : [];
  }).slice(0, 16);
  return (await Promise.all(pids.map(async (pid) => {
    let args: string, cwd: string | undefined;
    if (platform() === 'linux') {
      args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ');
      cwd = await realpath(`/proc/${pid}/cwd`).catch(() => undefined);
    } else {
      [args, cwd] = await Promise.all([
        command('ps', ['-ww', '-p', pid, '-o', 'args=']).catch(() => ''),
        command('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).then((value) => value.split('\n').find((line) => line.startsWith('n'))?.slice(1)).catch(() => undefined),
      ]);
    }
    const found = await paths(configFlags(args, cwd), 'Running llama-swap');
    const watching = /(?:^|\s)--?watch-config(?:=(?:true|1))?(?=\s|$)/.test(args);
    return found.map((entry) => ({ ...entry, pid: Number(pid), baseUrl: processEndpoint(args), watching }));
  }))).flat();
}

/** A stopped launchd service still tells us exactly which config it uses. */
export function launchdConfig(value: unknown): ReturnType<typeof configFlags> {
  if (!value || typeof value !== 'object') return [];
  const plist = value as { Program?: unknown; ProgramArguments?: unknown; WorkingDirectory?: unknown };
  const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments.filter((arg): arg is string => typeof arg === 'string') : [];
  const executable = typeof plist.Program === 'string' ? plist.Program : args[0];
  if (!executable || basename(executable) !== 'llama-swap') return [];
  return configFlags(args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' '), typeof plist.WorkingDirectory === 'string' ? plist.WorkingDirectory : undefined);
}

export function systemdConfig(text: string): ReturnType<typeof configFlags> {
  const lines = text.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/);
  const start = lines.find((line) => /^\s*ExecStart=/.test(line))?.replace(/^\s*ExecStart=\s*/, '') ?? '';
  if (!/(?:^|[\s/"'])llama-swap(?:[\s"']|$)/.test(start)) return [];
  const cwd = lines.find((line) => /^\s*WorkingDirectory=/.test(line))?.replace(/^\s*WorkingDirectory=\s*/, '').replace(/^['"]|['"]$/g, '');
  return configFlags(start, cwd && isAbsolute(cwd) ? cwd : undefined);
}

async function services(): Promise<DiscoveredLlamaSwapConfig[]> {
  const mac = platform() === 'darwin';
  const scratch = process.env['NODE_ENV'] !== 'production' && !!process.env['PI_KIT_HOME'];
  const folders = mac ? [join(homedir(), 'Library', 'LaunchAgents'), ...(scratch ? [] : ['/Library/LaunchAgents', '/Library/LaunchDaemons'])] :
    [join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'systemd', 'user'), ...(scratch ? [] : ['/etc/systemd/system', '/usr/lib/systemd/system'])];
  if (platform() === 'win32') return [];
  return (await Promise.all(folders.map(async (folder) => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    return (await Promise.all(entries.filter((entry) => /llama|llm/i.test(entry.name) && entry.name.endsWith(mac ? '.plist' : '.service')).slice(0, 64).map(async (entry) => {
      const path = join(folder, entry.name);
      try {
        if ((await stat(path)).size > 256_000) return [];
        const flags = mac ? launchdConfig(JSON.parse(await command('plutil', ['-convert', 'json', '-o', '-', path]))) : systemdConfig(await readFile(path, 'utf8'));
        return paths(flags, 'Service configuration');
      } catch { return []; }
    }))).flat();
  }))).flat();
}

export async function discoverLlamaSwapConfigs(): Promise<DiscoveredLlamaSwapConfig[]> {
  const [active, configured] = await Promise.all([running(), services()]);
  return [...active, ...configured];
}
