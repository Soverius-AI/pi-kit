import { existsSync, type FSWatcher, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The Omarchy desktop's theme as pi-kit's own tokens. Omarchy (omarchy.org) keeps the theme in effect in
 * `~/.local/state/omarchy/current`: `theme/colors.toml` is the palette every Omarchy app is tinted from, `theme.name` its name.
 * The renderer applies `tokens` to <html> as they are, so every value here is a `#rrggbb` colour and nothing else.
 */
export interface OmarchyTheme {
  /** The theme's slug, as `omarchy theme set` takes it. */
  name: string;
  mode: 'dark' | 'light';
  /** CSS custom properties: the daisyUI roles, pi-kit's own tokens and the sixteen terminal colours. */
  tokens: Record<string, string>;
}

type Palette = Record<string, string>;
type Rgb = [number, number, number];

const HEX = /^#[0-9a-f]{6}$/;
/** The six hues of a terminal palette, in ANSI order (colours 1 to 6; 9 to 14 are their bright forms). */
const ANSI = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];

const rgb = (hex: string): Rgb => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb;

/** `amount` of `end` over `start`, rounded the way Omarchy's own templates round. */
export function mix(start: string, end: string, amount: number): string {
  const from = rgb(start);
  const to = rgb(end);
  return `#${from
    .map((channel, index) =>
      Math.floor(channel * (1 - amount) + to[index] * amount + 0.5)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function luminance(hex: string): number {
  const [red, green, blue] = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** The WCAG contrast ratio of two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

/** The `key = "value"` lines of a colors.toml. A value that is not a `#rrggbb` colour or a plain word is dropped. */
export function parseColors(text: string): Palette {
  const palette: Palette = {};
  for (const line of text.split('\n')) {
    const match = /^\s*["']?([A-Za-z0-9_-]+)["']?\s*=\s*["']?([^"'#\s][^"'\s]*|#[0-9A-Fa-f]{6})["']?\s*(?:#.*)?$/.exec(
      line,
    );
    if (!match) continue;
    const value = match[2].toLowerCase();
    if (HEX.test(value) || /^[a-z]+$/.test(value)) palette[match[1]] = value;
  }
  return palette;
}

/**
 * Fills in what a theme left out, the way `omarchy-theme-color` does for Omarchy's own apps: older themes name their colours
 * `bg`, `fg` and `color0`…`color15`, and the shades are derived from the background when they are missing.
 * `undefined` when there is no background or foreground to start from.
 */
export function resolvePalette(raw: Palette, lightMarker = false): (Palette & { mode: 'dark' | 'light' }) | undefined {
  const colors: Palette = {};
  for (const [key, value] of Object.entries(raw)) if (HEX.test(value)) colors[key] = value;
  /** Keeps a colour the theme named; otherwise takes the first of `sources` that exists. */
  const fill = (key: string, ...sources: (string | undefined)[]): void => {
    const source = colors[key] ?? sources.find((candidate) => candidate !== undefined);
    if (source !== undefined) colors[key] = source;
  };
  for (const key of ['background', 'foreground']) {
    for (const shade of ['', 'dark_', 'darker_', 'lighter_', 'light_', 'bright_'])
      fill(shade + key, colors[shade + (key === 'background' ? 'bg' : 'fg')]);
  }
  fill('background', colors['color0']);
  fill('foreground', colors['color7']);
  const { background, foreground } = colors;
  if (!background || !foreground) return undefined;

  ANSI.forEach((name, index) => {
    fill(name, colors[`color${index + 1}`], name === 'magenta' ? colors['purple'] : undefined, foreground);
    fill(
      `bright_${name}`,
      colors[`color${index + 9}`],
      name === 'magenta' ? colors['bright_purple'] : undefined,
      mix(colors[name], '#ffffff', 0.2),
    );
  });
  fill('bright_foreground', colors['color15'], foreground);
  fill('dark_foreground', colors['color8'], foreground);
  fill('muted', colors['color8'], colors['dark_foreground']);
  fill('accent', colors['blue']);
  fill('dark_background', mix(background, '#000000', 0.25));
  fill('darker_background', mix(background, '#000000', 0.5));

  const named = raw['mode'] ?? raw['theme_type'];
  const [red, green, blue] = rgb(background);
  const mode =
    named === 'light' || named === 'dark' ? named : lightMarker || red + green + blue > 382 ? 'light' : 'dark';
  return { ...colors, mode };
}

/**
 * Text on a filled control: whichever end of the palette reads best on that fill. A mid-tone fill in a soft palette leaves both
 * ends short of 4.5:1; black or white always reaches it.
 */
function onFill(fill: string, palette: Palette): string {
  const best = (candidates: string[]): string =>
    candidates.reduce((kept, candidate) => (contrast(candidate, fill) > contrast(kept, fill) ? candidate : kept));
  const own = best(['darker_background', 'background', 'foreground', 'bright_foreground'].map((key) => palette[key]));
  return contrast(own, fill) >= 4.5 ? own : best([own, '#000000', '#ffffff']);
}

/**
 * Secondary text: the foreground faded towards the background as far as Omarchy's own apps fade it, but never below 4.5:1 on a
 * panel or the window. A theme whose foreground does not reach that itself keeps its foreground.
 */
function mutedText(foreground: string, surfaces: string[]): string {
  for (let fade = 0.34; fade > 0; fade -= 0.04) {
    const candidate = mix(foreground, surfaces[0], fade);
    if (surfaces.every((surface) => contrast(candidate, surface) >= 4.5)) return candidate;
  }
  return foreground;
}

/** The palette in pi-kit's roles (doc/docs/design-system.md, "Color"). */
export function omarchyTokens(palette: Palette): Record<string, string> {
  const { background, foreground, accent } = palette;
  const window = palette['dark_background'];
  const sunken = palette['darker_background'];
  const fills = {
    primary: accent,
    secondary: palette['magenta'],
    accent,
    info: palette['blue'],
    success: palette['green'],
    warning: palette['yellow'],
    error: palette['red'],
  };
  const tokens: Record<string, string> = {
    '--color-base-100': background,
    '--color-base-200': window,
    '--color-base-300': mix(background, foreground, 0.2),
    '--color-base-content': foreground,
    '--color-neutral': sunken,
    '--color-neutral-content': foreground,
    '--pk-muted': mutedText(foreground, [background, window]),
    '--pk-sunken': sunken,
    '--pk-sunken-content': foreground,
  };
  for (const [role, fill] of Object.entries(fills)) {
    tokens[`--color-${role}`] = fill;
    tokens[`--color-${role}-content`] = onFill(fill, palette);
  }
  // The terminal's sixteen colours, in the order Omarchy gives them to its own terminals.
  const terminal = [
    background,
    ...ANSI.map((name) => palette[name]),
    foreground,
    palette['muted'],
    ...ANSI.map((name) => palette[`bright_${name}`]),
    palette['bright_foreground'],
  ];
  terminal.forEach((color, index) => (tokens[`--pk-ansi-${index}`] = color));
  return tokens;
}

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * The theme in `current` (Omarchy's `~/.local/state/omarchy/current`). `undefined` for a theme without usable colours;
 * `'swapping'` while `omarchy theme set` has the old theme removed and the new one not yet moved in.
 */
export function readOmarchyTheme(current: string): OmarchyTheme | undefined | 'swapping' {
  const theme = join(current, 'theme');
  if (!existsSync(theme)) return 'swapping';
  const colors = read(join(theme, 'colors.toml'));
  const palette =
    colors === undefined ? undefined : resolvePalette(parseColors(colors), existsSync(join(theme, 'light.mode')));
  if (!palette) return undefined;
  const name = (read(join(current, 'theme.name')) ?? '').trim().slice(0, 64) || 'omarchy';
  return { name, mode: palette.mode, tokens: omarchyTokens(palette) };
}

/** Where Omarchy keeps the theme in effect, or `undefined` when this is not an Omarchy desktop. */
export function omarchyCurrentDir(platform: NodeJS.Platform = process.platform, home = homedir()): string | undefined {
  if (platform !== 'linux') return undefined;
  const current = join(home, '.local', 'state', 'omarchy', 'current');
  return existsSync(current) ? current : undefined;
}

/**
 * Follows the Omarchy theme. `omarchy theme set` builds the next theme beside the current one, swaps the two folders and then
 * writes `theme.generation` and `theme.name`, so the folder that holds them is watched, not a file inside the theme, which
 * would be gone after the first switch. Every change there is read again after a short pause and reported once the
 * colours or the name differ; Omarchy runs its own `theme-set` hook only after its last app has been retinted, which is later.
 */
export class OmarchyThemeWatcher {
  private theme: OmarchyTheme | undefined;
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly current: string,
    private readonly onChange: (theme: OmarchyTheme | undefined) => void,
    private readonly settleMs = 60,
  ) {
    const theme = readOmarchyTheme(current);
    this.theme = theme === 'swapping' ? undefined : theme;
  }

  /** The theme as it was last read. */
  get value(): OmarchyTheme | undefined {
    return this.theme;
  }

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.current, () => this.schedule());
      // A watch that fails later (the folder was removed) ends the following; the colours in effect stay.
      this.watcher.on('error', () => this.stop());
    } catch {
      this.watcher = undefined;
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), this.settleMs);
  }

  private refresh(): void {
    const theme = readOmarchyTheme(this.current);
    // Mid-swap there is nothing to read; the event of the new folder arriving reads it.
    if (theme === 'swapping') return;
    if (JSON.stringify(theme) === JSON.stringify(this.theme)) return;
    this.theme = theme;
    this.onChange(theme);
  }
}
