import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classify, decide, describeCall, driverToolName, enableWayland, explainToolError, exposureFor, host, hostApp, hyprlandPluginLoaded, HYPRLAND_READ_ONLY_NOTE, HYPRLAND_TOOL_HINT, inPiKit, isEnabled, isSupported, linuxInputHelp, linuxReadiness, missingPermissions, noPermissionsNote, permissionHelp, piToolName, setEnabled, toToolResult } from './computer-use.mjs';

describe('the saved choice', () => {
  let dir;
  let path;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'computer-use-'));
    path = join(dir, 'computer-use.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is off without a file, with a broken file, or with anything but true', () => {
    expect(isEnabled(path)).toBe(false);
    writeFileSync(path, '{ not json');
    expect(isEnabled(path)).toBe(false);
    writeFileSync(path, '{"enabled":"yes"}');
    expect(isEnabled(path)).toBe(false);
  });

  it('turns on and off, owner-readable only', () => {
    setEnabled(true, path);
    expect(isEnabled(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ enabled: true });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    setEnabled(false, path);
    expect(isEnabled(path)).toBe(false);
  });
});

describe('tools', () => {
  it('names the tools with a prefix both ways', () => {
    expect(piToolName('click')).toBe('computer_click');
    expect(driverToolName('computer_click')).toBe('click');
    expect(driverToolName('bash')).toBeUndefined();
  });

  it('lists the common tools and leaves the rest to tool search', () => {
    expect(exposureFor('click')).toBe('direct');
    expect(exposureFor('start_recording')).toBe('deferred');
  });

  it('classifies by the driver’s own hints', () => {
    const tool = (name, readOnlyHint, risk) => ({ name, annotations: { readOnlyHint }, risk: { class: risk } });
    expect(classify(tool('list_apps', true, 'r2'))).toBe('read');
    expect(classify(tool('click', false, 'r1'))).toBe('act');
    expect(classify(tool('page', false, 'r3'))).toBe('guarded');
    expect(classify(tool('kill_app', false, 'r3'))).toBe('guarded');
    expect(classify(tool('run_script', false, 'r1'))).toBe('guarded');
    expect(classify({ name: 'some_new_tool' })).toBe('act');
  });
});

describe('asking', () => {
  it('lets looking run, asks once per session for acting, and asks every time for guarded tools', () => {
    expect(decide({ kind: 'read', hasUI: true, sessionAllowed: false })).toEqual({ action: 'allow' });
    expect(decide({ kind: 'act', hasUI: true, sessionAllowed: false })).toEqual({ action: 'ask', ask: 'session' });
    expect(decide({ kind: 'act', hasUI: true, sessionAllowed: true })).toEqual({ action: 'allow' });
    expect(decide({ kind: 'guarded', hasUI: true, sessionAllowed: true })).toEqual({ action: 'ask', ask: 'call' });
  });

  it('blocks acting when nobody can be asked', () => {
    expect(decide({ kind: 'act', hasUI: false, sessionAllowed: true }).action).toBe('block');
    expect(decide({ kind: 'read', hasUI: false, sessionAllowed: false }).action).toBe('allow');
  });

  it('describes a call in one line without dumping its arguments', () => {
    expect(describeCall('click', { pid: 12, window_id: 3 })).toBe('click (pid 12)');
    expect(describeCall('type_text', { text: 'x'.repeat(100) })).toContain('...');
    expect(describeCall('list_apps', {})).toBe('list_apps');
  });
});

describe('results', () => {
  it('turns text and images into content blocks', () => {
    const { content } = toToolResult('zoom', { text: 'ok', images: [{ mimeType: 'image/png', dataBase64: 'AAAA' }], isError: false });
    expect(content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  it('cuts a very long text, never returns nothing, and throws the driver’s message on failure', () => {
    const { content } = toToolResult('get_accessibility_tree', { text: 'a'.repeat(70_000), images: [], isError: false });
    expect(content[0].text).toContain('10000 more characters cut');
    expect(toToolResult('click', { text: '', images: [], isError: false }).content).toEqual([{ type: 'text', text: 'Done.' }]);
    expect(() => toToolResult('click', { text: 'stale element', images: [], isError: true })).toThrow('stale element');
  });
});

describe('macOS permissions', () => {
  it('needs nothing outside macOS', () => {
    expect(missingPermissions('win32', { accessibility: false, screenRecording: false })).toEqual([]);
    expect(permissionHelp('win32', undefined)).toBeUndefined();
    expect(missingPermissions('linux', { accessibility: false, screenRecording: false })).toEqual([]);
    expect(permissionHelp('linux', undefined)).toBeUndefined();
    expect(['darwin', 'win32', 'linux'].map((p) => isSupported(p))).toEqual([true, true, true]);
    expect(isSupported('freebsd')).toBe(false);
    expect(noPermissionsNote('linux')).toMatch(/desktop session/);
    expect(noPermissionsNote('linux')).toMatch(/Hyprland, computer use is read-only/);
    expect(noPermissionsNote('win32')).toMatch(/^Windows needs no permissions/);
  });

  it('names what is missing and the app to switch on', () => {
    expect(missingPermissions('darwin', { accessibility: false, screenRecording: true })).toEqual(['Accessibility']);
    const help = permissionHelp('darwin', { accessibility: false, screenRecording: false }, { TERM_PROGRAM: 'iTerm.app' });
    expect(help).toContain('iTerm');
    expect(help).toContain('Accessibility and Screen & System Audio Recording');
    expect(permissionHelp('darwin', { accessibility: true, screenRecording: true })).toBeUndefined();
  });

  it('names the app macOS lists: pi-kit, Electron in development, or the terminal', () => {
    expect(host({ PI_KIT_DESKTOP: '1' }, '/Applications/pi-kit.app/Contents/MacOS/pi-kit')).toEqual({ name: 'pi-kit', kind: 'app', bundle: '/Applications/pi-kit.app' });
    expect(host({ PI_KIT_DESKTOP: '1' }, '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')).toMatchObject({ name: 'Electron', kind: 'development' });
    expect(host({ PI_KIT_DESKTOP: '1' }, 'C:\\Program Files\\pi-kit\\pi-kit.exe')).toEqual({ name: 'pi-kit', kind: 'app' });
    // pi-kit's backend started from a terminal (`pnpm run dev:web`) runs on the terminal's permissions.
    expect(host({ PI_KIT_TOKEN: 'x', TERM_PROGRAM: 'iTerm.app' }, '/usr/local/bin/node')).toEqual({ name: 'iTerm', kind: 'terminal' });
    expect(hostApp({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('Terminal');
    expect(hostApp({})).toBe('your terminal app');
  });

  it('points pi-kit users at the Settings page', () => {
    expect(inPiKit({ PI_KIT_TOKEN: 'x' })).toBe(true);
    expect(inPiKit({})).toBe(false);
    expect(permissionHelp('darwin', { accessibility: false, screenRecording: true }, { PI_KIT_DESKTOP: '1' }, '/Applications/pi-kit.app/Contents/MacOS/pi-kit')).toContain('Settings › Computer use');
    expect(permissionHelp('darwin', { accessibility: false, screenRecording: true }, { TERM_PROGRAM: 'Apple_Terminal' })).not.toContain('Settings');
  });
});

describe('the Wayland switch of Cua Driver', () => {
  it('is turned on in a Linux Wayland session, by session type or by a Wayland display', () => {
    const byType = { XDG_SESSION_TYPE: 'wayland' };
    expect(enableWayland(byType, 'linux')).toBe(true);
    expect(byType.CUA_DRIVER_RS_ENABLE_WAYLAND).toBe('1');
    const byDisplay = { WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' };
    expect(enableWayland(byDisplay, 'linux')).toBe(true);
    expect(byDisplay.CUA_DRIVER_RS_ENABLE_WAYLAND).toBe('1');
  });

  it('is left alone on X11, outside Linux, and when the person set it', () => {
    const x11 = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };
    expect(enableWayland(x11, 'linux')).toBe(false);
    expect(x11.CUA_DRIVER_RS_ENABLE_WAYLAND).toBeUndefined();
    const mac = { WAYLAND_DISPLAY: 'wayland-1' };
    expect(enableWayland(mac, 'darwin')).toBe(false);
    expect(mac.CUA_DRIVER_RS_ENABLE_WAYLAND).toBeUndefined();
    const off = { XDG_SESSION_TYPE: 'wayland', CUA_DRIVER_RS_ENABLE_WAYLAND: '0' };
    expect(enableWayland(off, 'linux')).toBe(false);
    expect(off.CUA_DRIVER_RS_ENABLE_WAYLAND).toBe('0');
  });
});

describe('Hyprland', () => {
  const hypr = { HYPRLAND_INSTANCE_SIGNATURE: 'abc', XDG_SESSION_TYPE: 'wayland' };
  const loaded = async () => '{"name":"cua-hyprland-plugin","state":"discovery_only"}';
  const missing = async () => 'unknown request';
  const noHyprctl = async () => {
    throw new Error('spawn hyprctl ENOENT');
  };

  it('knows whether the plugin answers hyprctl', async () => {
    expect(await hyprlandPluginLoaded(loaded)).toBe(true);
    expect(await hyprlandPluginLoaded(missing)).toBe(false);
    expect(await hyprlandPluginLoaded(noHyprctl)).toBe(false);
  });

  it('reads what a Linux session offers, and asks hyprctl only on Hyprland', async () => {
    expect(await linuxReadiness(hypr, 'linux', missing)).toEqual({ wayland: true, hyprland: true, hyprlandPlugin: false });
    expect(await linuxReadiness(hypr, 'linux', loaded)).toEqual({ wayland: true, hyprland: true, hyprlandPlugin: true });
    expect(await linuxReadiness({ XDG_SESSION_TYPE: 'wayland' }, 'linux', noHyprctl)).toEqual({ wayland: true, hyprland: false, hyprlandPlugin: false });
    expect(await linuxReadiness({ DISPLAY: ':0' }, 'linux', noHyprctl)).toEqual({ wayland: false, hyprland: false, hyprlandPlugin: false });
    expect(await linuxReadiness(hypr, 'darwin', loaded)).toBeUndefined();
  });

  it('warns on Hyprland without the plugin and nowhere else', () => {
    expect(linuxInputHelp({ wayland: true, hyprland: true, hyprlandPlugin: false })).toBe(HYPRLAND_READ_ONLY_NOTE);
    expect(HYPRLAND_READ_ONLY_NOTE).toContain('read-only');
    expect(linuxInputHelp({ wayland: true, hyprland: true, hyprlandPlugin: true })).toBeUndefined();
    expect(linuxInputHelp({ wayland: true, hyprland: false, hyprlandPlugin: false })).toBeUndefined();
    expect(linuxInputHelp(undefined)).toBeUndefined();
  });

  it('appends the read-only hint to an input the compositor refused, and leaves other errors alone', () => {
    const refused = 'foreground_unavailable (unsupported_operation): production Hyprland input plugin is unavailable';
    expect(explainToolError(refused, hypr)).toBe(`${refused}\n\n${HYPRLAND_TOOL_HINT}`);
    expect(explainToolError('Background delivery is not available: the requested target has no focus-free input backend; ...', hypr)).toContain(HYPRLAND_TOOL_HINT);
    expect(explainToolError('No windows found for pid 0. Provide window_id.', hypr)).toBe('No windows found for pid 0. Provide window_id.');
    expect(explainToolError(refused, { XDG_SESSION_TYPE: 'wayland' })).toBe(refused);
    expect(() => toToolResult('click', { text: refused, images: [], isError: true }, hypr)).toThrow(/only look/);
  });
});
