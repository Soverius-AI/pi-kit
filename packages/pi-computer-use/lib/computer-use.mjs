// The logic of the extension without pi or the driver in it, so it can be tested: the one saved choice, which tools the model sees,
// when to ask, what a result looks like, and what to tell the person when macOS has not given permission.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// --- the one saved choice: computer use is off until `/computer-use on` ---

export function configPath(env = process.env) {
  return join(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'computer-use.json');
}

export function isEnabled(path = configPath()) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).enabled === true;
  } catch {
    return false;
  }
}

/** Written beside the file and renamed over it, so a crash never leaves half a file. */
export function setEnabled(enabled, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

// --- tools ---

export const TOOL_PREFIX = 'computer_';

/** The tools the model sees in its tool list; the driver's other tools are found with tool_search. */
const COMMON_TOOLS = new Set([
  'list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'get_accessibility_tree', 'zoom', 'verify_state', 'get_screen_size',
  'launch_app', 'bring_to_front', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text', 'press_key', 'hotkey', 'set_value', 'invoke_menu',
]);

/** Run a script or a sequence, end a program, store or download something: asked every time. */
const ALWAYS_ASK = new Set(['kill_app', 'run_script', 'run_steps', 'replay_trajectory', 'install_ffmpeg', 'browser_download', 'browser_set_input_files', 'set_config']);

export const piToolName = (name) => `${TOOL_PREFIX}${name}`;
export const driverToolName = (piName) => (piName.startsWith(TOOL_PREFIX) ? piName.slice(TOOL_PREFIX.length) : undefined);
export const exposureFor = (name) => (COMMON_TOOLS.has(name) ? 'direct' : 'deferred');

/** Without this line a model that has a shell often writes AppleScript before it tries the computer tools. */
export const GUIDELINE = 'To look at or operate desktop apps and windows, use the computer_* tools (start with computer_list_apps), not AppleScript, osascript or `open -a`.';

// --- asking ---

/** `read` only looks; `act` changes something on screen; `guarded` is asked every time. The driver's own hints decide, so a new tool needs no change here. */
export function classify(tool) {
  if (ALWAYS_ASK.has(tool.name)) return 'guarded';
  if (tool.annotations?.readOnlyHint === true) return 'read';
  return tool.risk?.class === 'r3' ? 'guarded' : 'act';
}

/** `allow`, `block` (with a reason), or `ask` (`session`: once for the session, `call`: this call). */
export function decide({ kind, hasUI, sessionAllowed }) {
  if (kind === 'read') return { action: 'allow' };
  if (!hasUI) return { action: 'block', reason: 'Computer use needs the person’s approval, and this run has no way to ask.' };
  if (kind === 'guarded') return { action: 'ask', ask: 'call' };
  return sessionAllowed ? { action: 'allow' } : { action: 'ask', ask: 'session' };
}

/** One line for the question: the tool, and the target when the arguments name one. */
export function describeCall(name, input) {
  const args = input && typeof input === 'object' ? input : {};
  const target = args.target && typeof args.target === 'object' ? args.target : {};
  const parts = [];
  const pid = args.pid ?? target.pid;
  if (pid !== undefined) parts.push(`pid ${pid}`);
  if (typeof args.text === 'string') parts.push(JSON.stringify(args.text.length > 60 ? `${args.text.slice(0, 57)}...` : args.text));
  if (typeof args.key === 'string') parts.push(`key ${args.key}`);
  if (typeof args.bundle_id === 'string') parts.push(args.bundle_id);
  if (typeof args.url === 'string') parts.push(args.url);
  return parts.length ? `${name} (${parts.join(', ')})` : name;
}

// --- results ---

/** An accessibility tree of a busy window can be very large: the model gets the start and is told it was cut. */
const MAX_TEXT_CHARS = 60_000;

/** The driver's `{ text, images: [{ mimeType, dataBase64 }], isError }` as pi's tool result. A failed tool throws, so pi marks it an error. */
export function toToolResult(name, result) {
  if (result.isError) throw new Error(result.text || `${name} failed`);
  /** @type {({ type: 'text', text: string } | { type: 'image', data: string, mimeType: string })[]} */
  const content = [];
  let text = result.text ?? '';
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…${text.length - MAX_TEXT_CHARS} more characters cut. Use a smaller window or zoom.`;
  if (text) content.push({ type: 'text', text });
  for (const image of result.images ?? []) content.push({ type: 'image', data: image.dataBase64, mimeType: image.mimeType || 'image/png' });
  if (content.length === 0) content.push({ type: 'text', text: 'Done.' });
  return { content, details: { tool: name } };
}

// --- the platforms Cua Driver ships for: macOS and Windows, and Linux in an X11 or Wayland desktop session ---

export const SUPPORTED_PLATFORMS = ['darwin', 'win32', 'linux'];
export const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
export const isSupported = (platform = process.platform) => SUPPORTED_PLATFORMS.includes(platform);
export const unsupportedMessage = (platform = process.platform) => `Computer use supports macOS, Windows and Linux; this is ${platform}.`;
/** Outside macOS there is nothing to grant: Windows needs no permissions, Linux a desktop session and, on Hyprland, Cua's compositor plugin for input. */
export const noPermissionsNote = (platform = process.platform) =>
  platform === 'linux'
    ? 'Linux needs no permissions for computer use; it needs a desktop session (X11, or Wayland with XWayland or native Wayland routes) and the AT-SPI accessibility bus (at-spi2-core). On Hyprland (Omarchy), input also needs the cua-hyprland-plugin loaded in the compositor.'
    : `${PLATFORM_NAMES[platform] ?? platform} needs no permissions for computer use. Nothing to set up.`;

/** The switch that turns on Cua Driver's native Wayland routes; without it a Wayland session only reaches apps that run under XWayland. */
export const WAYLAND_SWITCH = 'CUA_DRIVER_RS_ENABLE_WAYLAND';
export const isWaylandSession = (env = process.env) => env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
/** Turns on the native Wayland routes in a Linux Wayland session, before the driver is created. A value the person set (`0` included) is kept. */
export function enableWayland(env = process.env, platform = process.platform) {
  if (platform !== 'linux' || !isWaylandSession(env) || env[WAYLAND_SWITCH] !== undefined) return false;
  env[WAYLAND_SWITCH] = '1';
  return true;
}

// --- macOS permissions: granted to the app that started pi (the terminal, or pi-kit), not to this package ---

/** The two macOS permissions, in the order setup goes through them, with the System Settings page of each. */
export const PERMISSIONS = [
  { key: 'accessibility', name: 'Accessibility', pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' },
  { key: 'screenRecording', name: 'Screen & System Audio Recording', pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' },
];

export function missingPermissions(platform, status) {
  if (platform !== 'darwin') return [];
  return PERMISSIONS.filter((p) => !status?.[p.key]).map((p) => p.name);
}

const terminalName = (env) => ({ Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', vscode: 'Visual Studio Code' })[env.TERM_PROGRAM] ?? env.TERM_PROGRAM ?? 'your terminal app';

/**
 * The app macOS gives the permissions to: the one that started this process. pi-kit's desktop app starts its backend (`PI_KIT_DESKTOP`): a packaged build is
 * listed as "pi-kit", a development build runs Electron's own app, which macOS lists as "Electron". Anything started from a terminal (the pi command line, or
 * pi-kit's backend under `pnpm run dev:web`) uses the terminal's permissions.
 * @returns {{ name: string, kind: 'app' | 'development' | 'terminal', bundle?: string }}
 */
export function host(env = process.env, execPath = process.execPath) {
  if (!env.PI_KIT_DESKTOP) return { name: terminalName(env), kind: 'terminal' };
  const bundle = /^(.*?\.app)\//.exec(execPath)?.[1];
  if (bundle && /\/Electron\.app$/.test(bundle)) return { name: 'Electron', kind: 'development', bundle };
  return { name: 'pi-kit', kind: 'app', ...(bundle ? { bundle } : {}) };
}

export const hostApp = (env = process.env, execPath = process.execPath) => host(env, execPath).name;

/** pi-kit runs this session (its desktop app or its backend on its own): it has a Settings page for all this. */
export const inPiKit = (env = process.env) => Boolean(env.PI_KIT_DESKTOP || env.PI_KIT_TOKEN);

export function permissionHelp(platform, status, env = process.env, execPath = process.execPath) {
  const missing = missingPermissions(platform, status);
  if (missing.length === 0) return undefined;
  const app = hostApp(env, execPath);
  const how = inPiKit(env) ? 'Open Settings › Computer use (or run /computer-use setup)' : 'Run /computer-use setup';
  return `macOS has not given ${app} these permissions yet: ${missing.join(' and ')}. ${how}, switch ${app} on under each, then quit and reopen ${app} (macOS applies a Screen Recording grant only to a restarted app).`;
}
