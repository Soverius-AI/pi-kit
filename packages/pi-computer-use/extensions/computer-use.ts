// @pi-kit/computer-use: opt-in computer use for pi on macOS, Windows and Linux, through Cua Driver (https://github.com/trycua/cua).
//
// Cua Driver runs in this process through its npm SDK (`@trycua/cua-driver`; the native library for the OS comes with it): no installer, no daemon.
//   /computer-use on | off | setup | status     off until `on`; `setup` walks through the macOS permissions one page at a time and moves on once macOS reports
//                                               each one (Windows and Linux need none; Hyprland is read-only, and `status` says so); in pi-kit, Settings › Computer use
//                                               does the same with live status and a Relaunch button
//   computer_<tool>                             the driver's own tools, read from the driver when computer use turns on
//   approval                                    looking runs; acting asks once per session; scripts, quitting apps and downloads ask every time
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { classify, configPath, decide, describeCall, driverToolName, enableWayland, exposureFor, GUIDELINE, host, inPiKit, isEnabled, isSupported, linuxInputHelp, linuxReadiness, noPermissionsNote, PERMISSIONS, permissionHelp, piToolName, setEnabled, toToolResult, unsupportedMessage } from '../lib/computer-use.mjs';

interface DriverTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  risk?: { class?: string };
}
type Permissions = { accessibility: boolean; screenRecording: boolean };
interface Driver {
  callTool(name: string, argumentsJson: string, opts?: { signal: AbortSignal }): Promise<{ text: string; images: { mimeType: string; dataBase64: string }[]; isError: boolean }>;
  listToolsJson(): Promise<string>;
  shutdown(): Promise<unknown>;
}
interface Sdk {
  CuaDriver: { create(options: { embedded: boolean; claudeCodeCompatibility: boolean }): Driver };
  currentMacOsPermissionStatus(): Permissions;
  requestMacOsPermissions(): Permissions;
}

const SUPPORTED = isSupported();

const STEPS = PERMISSIONS as readonly { key: keyof Permissions; name: string; pane: string }[];
/** How often setup asks macOS whether the open step was granted. */
const POLL_MS = 1000;
/** The suggestion pill pi-kit shows above the composer while a permission is missing (`pi-kit:composer`, doc/docs/plugins.md). */
const SETUP_PILL = 'computer-use-setup';

export default function (pi: ExtensionAPI) {
  let sdk: Sdk | undefined;
  let driver: Driver | undefined;
  let sessionAllowed = false;
  const tools = new Map<string, DriverTool>();

  /** The SDK is loaded only once computer use is on. A build without it (pi-kit ships it for macOS, Windows and Linux; `npm install` brings it otherwise) says so instead of a resolution error. */
  const loadSdk = async () =>
    (sdk ??= (await import('@trycua/cua-driver').catch((error: unknown) => {
      throw new Error(`Cua Driver is not installed next to this package (${error instanceof Error ? error.message : String(error)}). Reinstall the package, or pi-kit, to get it.`);
    })) as unknown as Sdk);
  /**
   * `embedded` keeps the driver in this process instead of looking for an installed CuaDriver app. In a Linux Wayland session the driver's
   * native Wayland routes are turned on first (it reads the switch from the environment); without them it only reaches XWayland apps.
   */
  const getDriver = async () => {
    if (driver) return driver;
    const loaded = await loadSdk();
    enableWayland();
    return (driver = loaded.CuaDriver.create({ embedded: true, claudeCodeCompatibility: false }));
  };
  const permissions = async (): Promise<Permissions> => (process.platform === 'darwin' ? (await loadSdk()).currentMacOsPermissionStatus() : { accessibility: true, screenRecording: true });

  /** A tool cannot be unregistered, so "off" registers each one again as hidden. */
  async function registerTools(on: boolean) {
    if (tools.size === 0) {
      const listed = JSON.parse(await (await getDriver()).listToolsJson()) as DriverTool[] | { tools: DriverTool[] };
      for (const tool of Array.isArray(listed) ? listed : listed.tools) tools.set(tool.name, tool);
    }
    for (const tool of tools.values()) {
      pi.registerTool({
        name: piToolName(tool.name),
        label: `Computer: ${tool.name}`,
        description: tool.description ?? tool.name,
        promptGuidelines: tool.name === 'list_apps' ? [GUIDELINE] : undefined,
        parameters: Type.Unsafe(tool.inputSchema ?? { type: 'object', properties: {} }),
        exposure: on ? exposureFor(tool.name) : 'hidden',
        annotations: tool.annotations,
        executionMode: 'sequential',
        async execute(_id, params, signal) {
          const help = permissionHelp(process.platform, await permissions());
          if (help) throw new Error(help);
          return toToolResult(tool.name, await (await getDriver()).callTool(tool.name, JSON.stringify(params ?? {}), signal ? { signal } : undefined));
        },
      });
    }
  }

  /** In pi-kit, a pill that opens Settings › Computer use while macOS still lacks a permission; gone once both are there. Nothing elsewhere. */
  function showSetupPill(missing: boolean) {
    if (!inPiKit() || process.platform !== 'darwin') return;
    pi.events.emit('pi-kit:composer', missing ? { op: 'suggestion', id: SETUP_PILL, title: 'Set up computer use permissions', text: '/settings computer-use', send: true } : { op: 'remove', id: SETUP_PILL });
  }

  async function stop() {
    sessionAllowed = false;
    const current = driver;
    driver = undefined;
    await current?.shutdown().catch(() => undefined);
  }

  /** Linux: what the session offers (Wayland, Hyprland and its plugin) and, while the driver runs, its own check of the session. */
  async function linuxStatus(): Promise<{ lines: string[]; help?: string }> {
    const readiness = await linuxReadiness();
    const help = linuxInputHelp(readiness);
    const lines = [readiness?.hyprland ? (readiness.hyprlandPlugin ? 'Hyprland: Cua’s plugin is loaded.' : undefined) : readiness?.wayland ? 'Wayland session: the driver’s native Wayland routes are on.' : 'X11 session.'];
    if (driver) lines.push((await driver.callTool('check_permissions', '{}').catch(() => undefined))?.text?.trim() ?? '');
    return { lines: lines.filter(Boolean), help };
  }

  async function status(ctx: ExtensionContext) {
    const macHelp = SUPPORTED ? permissionHelp(process.platform, await permissions().catch(() => ({ accessibility: false, screenRecording: false }))) : undefined;
    const linux = SUPPORTED && process.platform === 'linux' ? await linuxStatus() : { lines: [] };
    const help = macHelp ?? linux.help;
    const detail = SUPPORTED ? [macHelp ?? (process.platform === 'linux' ? undefined : 'Permissions: ready.'), ...linux.lines, linux.help].filter(Boolean).join('\n') : `Not supported on ${process.platform}.`;
    ctx.ui.notify(`Computer use is ${isEnabled() ? 'on' : 'off'} (${configPath()}).\n${detail}`, help ? 'warning' : 'info');
  }

  /**
   * macOS only: one permission at a time. Open its page and wait until macOS reports the grant (checked every second; the dialog then closes by itself) or the
   * person says "Done". Asking macOS first is what puts the app in each list, switched off. A grant for Screen Recording is applied by macOS only to an app that
   * is started again, so the last message says that. In pi-kit the steps still work, and the pill points at Settings › Computer use, which shows both live.
   */
  async function setup(ctx: ExtensionContext) {
    if (process.platform !== 'darwin') {
      const help = process.platform === 'linux' ? linuxInputHelp(await linuxReadiness()) : undefined;
      return ctx.ui.notify(SUPPORTED ? (help ? `${noPermissionsNote()}\n\n${help}` : noPermissionsNote()) : `Not supported on ${process.platform}.`, help ? 'warning' : 'info');
    }
    const app = host();
    const before = await permissions();
    const todo = STEPS.filter((step) => !before[step.key]);
    showSetupPill(todo.length > 0);
    if (todo.length === 0) return ctx.ui.notify(`macOS has already given ${app.name} both permissions. Nothing to do.`, 'info');
    if (!ctx.hasUI) return ctx.ui.notify(permissionHelp('darwin', before) ?? '', 'warning');
    (await loadSdk()).requestMacOsPermissions();
    const { execFile } = await import('node:child_process');
    for (const [index, step] of todo.entries()) {
      execFile('open', [step.pane], () => undefined);
      const granted = new AbortController();
      const poll = setInterval(() => {
        permissions()
          .then((now) => now[step.key] && granted.abort())
          .catch(() => undefined);
      }, POLL_MS);
      let answer: string | undefined;
      try {
        answer = await ctx.ui.select(`Step ${index + 1} of ${todo.length}: ${step.name}. Find "${app.name}" in the list in System Settings and switch it on.`, ['Done, next', 'Stop setup'], { signal: granted.signal });
      } finally {
        clearInterval(poll);
      }
      if (granted.signal.aborted) ctx.ui.notify(`${step.name}: macOS has given it to ${app.name}.`, 'info');
      else if (answer !== 'Done, next') return ctx.ui.notify('Setup stopped. Run /computer-use setup to continue.', 'info');
    }
    const after = await permissions().catch(() => before);
    showSetupPill(STEPS.some((step) => !after[step.key]));
    if (todo.some((step) => step.key === 'screenRecording')) {
      const restart = app.kind === 'terminal' ? `Quit ${app.name} and open it again` : `Quit ${app.name} and open it again (Settings › Computer use has a Relaunch button)`;
      ctx.ui.notify(`${restart}: macOS applies Screen Recording only to an app that starts again. Then run /computer-use status.`, 'info');
    } else {
      ctx.ui.notify('Computer use has the permissions it needs.', 'info');
    }
  }

  pi.registerCommand('computer-use', {
    description: 'Computer use (Cua Driver): /computer-use on | off | setup | status',
    handler: async (args, ctx) => {
      const word = (args ?? '').trim() || 'status';
      try {
        if (word === 'on') {
          if (!SUPPORTED) throw new Error(unsupportedMessage());
          if (!isEnabled() && !(await ctx.ui.confirm('Turn on computer use?', 'pi will be able to see your screen and operate apps on this computer. It asks before it acts. What an app shows can contain instructions meant for pi.'))) return;
          setEnabled(true);
          await registerTools(true);
          ctx.ui.notify('Computer use is on.', 'info');
          const help = permissionHelp(process.platform, await permissions()) ?? (process.platform === 'linux' ? linuxInputHelp(await linuxReadiness()) : undefined);
          showSetupPill(Boolean(help));
          if (help) ctx.ui.notify(help, 'warning');
        } else if (word === 'off') {
          setEnabled(false);
          showSetupPill(false);
          if (tools.size) await registerTools(false);
          await stop();
          ctx.ui.notify('Computer use is off.', 'info');
        } else if (word === 'setup') {
          await setup(ctx);
        } else {
          await status(ctx);
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  // Someone who never ran `/computer-use on` gets no tools and no native library.
  pi.on('session_start', async (_event, ctx) => {
    sessionAllowed = false;
    if (!SUPPORTED || !isEnabled()) return;
    try {
      await registerTools(true);
      showSetupPill(Boolean(permissionHelp(process.platform, await permissions())));
    } catch (error) {
      ctx.ui.notify(`Computer use could not start: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });

  pi.on('session_shutdown', stop);

  pi.on('tool_call', async (event, ctx) => {
    const name = driverToolName(event.toolName);
    const tool = name === undefined ? undefined : tools.get(name);
    if (!name || !tool) return undefined;
    if (!isEnabled()) return { block: true, reason: 'Computer use is off. The person can turn it on with /computer-use on.' };
    const step = decide({ kind: classify(tool), hasUI: ctx.hasUI, sessionAllowed });
    if (step.action === 'allow') return undefined;
    if (step.action === 'block') return { block: true, reason: step.reason };
    const line = describeCall(name, event.input);
    if (step.ask === 'call') return (await ctx.ui.confirm('Allow this computer action?', line)) ? undefined : { block: true, reason: `The person did not allow ${name}.` };
    sessionAllowed = await ctx.ui.confirm('Allow pi to use this computer for this session?', `It will operate apps on your behalf, starting with: ${line}`);
    return sessionAllowed ? undefined : { block: true, reason: 'The person did not allow computer use.' };
  });
}
