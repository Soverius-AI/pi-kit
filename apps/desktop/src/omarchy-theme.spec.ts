import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contrast,
  mix,
  omarchyCurrentDir,
  omarchyTokens,
  type OmarchyTheme,
  OmarchyThemeWatcher,
  parseColors,
  readOmarchyTheme,
  resolvePalette,
} from './omarchy-theme';
import {
  asOmarchyTheme,
  omarchyThemeArgument,
  omarchyThemeFromArguments,
  startingOmarchyTheme,
} from './omarchy-theme-handoff';

const TOKYO_NIGHT = `mode = "dark"

accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"

background = "#1a1b26"
dark_background = "#13141c"
darker_background = "#0e0e14"
lighter_background = "#24283b"

foreground = "#a9b1d6"
dark_foreground = "#565f89"
bright_foreground = "#c0caf5"

red = "#f7768e"
yellow = "#e0af68"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"

bright_red = "#ff7a93"
bright_yellow = "#ff9e64"
bright_green = "#b9f27c"
bright_cyan = "#0db9d7"
bright_blue = "#7da6ff"
bright_magenta = "#bb9af7"
`;
const LATTE = `mode = "light"
accent = "#1e66f5"
muted = "#acb0be"
background = "#eff1f5"
dark_background = "#e3e4e8"
darker_background = "#d7d8dc"
foreground = "#4c4f69"
bright_foreground = "#4c4f69"
red = "#d20f39"
yellow = "#df8e1d"
green = "#40a02b"
cyan = "#179299"
blue = "#1e66f5"
magenta = "#8839ef"
`;

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

/** A folder laid out like Omarchy's `~/.local/state/omarchy/current`. */
async function currentDir(colors: string | undefined, name = 'tokyo-night'): Promise<string> {
  const current = await mkdtemp(join(tmpdir(), 'pi-kit-omarchy-'));
  folders.push(current);
  await mkdir(join(current, 'theme'));
  if (colors !== undefined) await writeFile(join(current, 'theme', 'colors.toml'), colors);
  await writeFile(join(current, 'theme.name'), `${name}\n`);
  return current;
}

/** What `omarchy theme set` does: builds the next theme beside the current one, swaps the folders, then names the switch. */
async function switchTheme(current: string, colors: string, name: string): Promise<void> {
  await mkdir(join(current, 'next-theme'));
  await writeFile(join(current, 'next-theme', 'colors.toml'), colors);
  await rm(join(current, 'theme'), { recursive: true });
  await rename(join(current, 'next-theme'), join(current, 'theme'));
  await writeFile(join(current, 'theme.generation'), `${Date.now()}\n`);
  await writeFile(join(current, 'theme.name'), `${name}\n`);
}

describe('colors.toml', () => {
  it('keeps colours and plain words, and drops everything that is neither', () => {
    const palette = parseColors(
      [
        'mode = "light"',
        'accent = "#7AA2F7" # the accent',
        "background = '#1a1b26'",
        'gradient = "rgba(1, 2, 3, 0.5) 45deg"',
        'evil = "#fff; background: url(https://example.com)"',
        '# foreground = "#ffffff"',
        '[section]',
      ].join('\n'),
    );
    expect(palette).toEqual({ mode: 'light', accent: '#7aa2f7', background: '#1a1b26' });
  });

  it('reads a theme that only names the terminal colours, and tells light from dark by the background', () => {
    const colors = Object.fromEntries(
      ['#fafafa', '#c00000', '#00a000', '#a0a000', '#0000c0', '#a000a0', '#00a0a0', '#202020'].map((color, index) => [
        `color${index}`,
        color,
      ]),
    );
    const palette = resolvePalette(colors);
    expect(palette).toMatchObject({
      mode: 'light',
      background: '#fafafa',
      foreground: '#202020',
      red: '#c00000',
      accent: '#0000c0',
      dark_background: mix('#fafafa', '#000000', 0.25),
    });
    expect(resolvePalette({ ...colors, color0: '#101010', color7: '#e0e0e0' })?.mode).toBe('dark');
    expect(resolvePalette({ ...colors, mode: 'dark' })?.mode).toBe('dark');
  });

  it('has nothing to offer without a background and a foreground', () => {
    expect(resolvePalette({ accent: '#7aa2f7', background: '#1a1b26' })).toBeUndefined();
  });
});

describe('tokens', () => {
  const tokens = (colors: string) => omarchyTokens(resolvePalette(parseColors(colors)) as Record<string, string>);

  it('puts the palette into pi-kit’s roles', () => {
    expect(tokens(TOKYO_NIGHT)).toMatchObject({
      '--color-base-100': '#1a1b26',
      '--color-base-200': '#13141c',
      '--color-base-content': '#a9b1d6',
      '--color-primary': '#7aa2f7',
      '--color-secondary': '#ad8ee6',
      '--color-success': '#9ece6a',
      '--color-warning': '#e0af68',
      '--color-error': '#f7768e',
      '--pk-sunken': '#0e0e14',
      '--pk-sunken-content': '#a9b1d6',
      '--pk-ansi-0': '#1a1b26',
      '--pk-ansi-1': '#f7768e',
      '--pk-ansi-8': '#414868',
      '--pk-ansi-13': '#bb9af7',
      '--pk-ansi-15': '#c0caf5',
    });
  });

  it.each([
    ['a dark theme', TOKYO_NIGHT],
    ['a light theme', LATTE],
  ])('keeps text readable in %s', (_name, colors) => {
    const all = tokens(colors);
    for (const surface of ['--color-base-100', '--color-base-200']) {
      expect(contrast(all['--pk-muted'], all[surface])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(all['--color-base-content'], all[surface])).toBeGreaterThanOrEqual(4.5);
    }
    for (const role of ['primary', 'secondary', 'info', 'success', 'warning', 'error'])
      expect(contrast(all[`--color-${role}-content`], all[`--color-${role}`])).toBeGreaterThanOrEqual(4.5);
    expect(Object.values(all).every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
  });
});

describe('the theme in effect', () => {
  it('is read from the current folder', async () => {
    const theme = readOmarchyTheme(await currentDir(TOKYO_NIGHT)) as OmarchyTheme;
    expect(theme.name).toBe('tokyo-night');
    expect(theme.mode).toBe('dark');
    expect(theme.tokens['--color-primary']).toBe('#7aa2f7');
  });

  it('is none for a theme without colours, and unknown while the theme folder is being swapped', async () => {
    const current = await currentDir(undefined);
    expect(readOmarchyTheme(current)).toBeUndefined();
    await rm(join(current, 'theme'), { recursive: true });
    expect(readOmarchyTheme(current)).toBe('swapping');
  });

  it('is looked for on Linux only, where Omarchy keeps it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-kit-omarchy-home-'));
    folders.push(home);
    expect(omarchyCurrentDir('linux', home)).toBeUndefined();
    const current = join(home, '.local', 'state', 'omarchy', 'current');
    await mkdir(current, { recursive: true });
    expect(omarchyCurrentDir('linux', home)).toBe(current);
    expect(omarchyCurrentDir('darwin', home)).toBeUndefined();
  });
});

describe('following the theme', () => {
  const next = (changes: (OmarchyTheme | undefined)[], count: number): Promise<void> =>
    expect.poll(() => changes.length, { timeout: 2000 }).toBeGreaterThanOrEqual(count);

  it('reports each switch once, with the new colours and name', async () => {
    const current = await currentDir(TOKYO_NIGHT);
    const changes: (OmarchyTheme | undefined)[] = [];
    const watcher = new OmarchyThemeWatcher(current, (theme) => changes.push(theme), 20);
    watcher.start();
    try {
      expect(watcher.value?.mode).toBe('dark');
      await switchTheme(current, LATTE, 'catppuccin-latte');
      await next(changes, 1);
      // The watch is on the folder, not on the theme that was removed: a second switch is seen too.
      await switchTheme(current, TOKYO_NIGHT, 'tokyo-night');
      await next(changes, 2);
      expect(changes.map((theme) => [theme?.name, theme?.mode])).toEqual([
        ['catppuccin-latte', 'light'],
        ['tokyo-night', 'dark'],
      ]);
      expect(watcher.value?.name).toBe('tokyo-night');
    } finally {
      watcher.stop();
    }
  });

  it('says nothing when the folder changes and the theme does not, and keeps the colours while a swap is under way', async () => {
    const current = await currentDir(TOKYO_NIGHT);
    const changes: (OmarchyTheme | undefined)[] = [];
    const watcher = new OmarchyThemeWatcher(current, (theme) => changes.push(theme), 20);
    watcher.start();
    try {
      await writeFile(join(current, 'theme.generation'), 'again\n');
      await rm(join(current, 'theme'), { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(changes).toEqual([]);
      expect(watcher.value?.name).toBe('tokyo-night');
    } finally {
      watcher.stop();
    }
  });
});

describe('handing the theme to a window', () => {
  const theme: OmarchyTheme = { name: 'tokyo-night', mode: 'dark', tokens: { '--color-primary': '#7aa2f7' } };

  it('survives the trip through the renderer’s arguments', () => {
    expect(omarchyThemeFromArguments(['electron', '--type=renderer', omarchyThemeArgument(theme)])).toEqual(theme);
    expect(omarchyThemeFromArguments(['electron', '--type=renderer'])).toBeUndefined();
    expect(omarchyThemeFromArguments(['--pi-kit-omarchy-theme=%7Bbroken'])).toBeUndefined();
  });

  it('leaves a window that has an explicit theme chosen to that theme', () => {
    expect(startingOmarchyTheme(theme, undefined)).toBe(theme);
    expect(startingOmarchyTheme(theme, 'system')).toBe(theme);
    expect(startingOmarchyTheme(theme, 'pi-dark')).toBeUndefined();
    expect(startingOmarchyTheme(undefined, 'system')).toBeUndefined();
  });

  it('refuses a token that is not a colour', () => {
    expect(asOmarchyTheme(theme)).toEqual(theme);
    expect(asOmarchyTheme({ ...theme, tokens: { '--color-primary': 'url(https://example.com)' } })).toBeUndefined();
    expect(asOmarchyTheme({ ...theme, tokens: { color: '#7aa2f7' } })).toBeUndefined();
    expect(asOmarchyTheme({ ...theme, mode: 'sepia' })).toBeUndefined();
    expect(asOmarchyTheme(undefined)).toBeUndefined();
  });
});
