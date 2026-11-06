import type { OmarchyTheme } from './omarchy-theme';

/**
 * How the Omarchy theme reaches a window before its first paint: main appends it to the renderer's arguments
 * (`webPreferences.additionalArguments`) and the preload reads it back, which needs no round trip.
 * No Node imports here: the sandboxed preload bundles this file.
 */
const ARGUMENT = '--pi-kit-omarchy-theme=';

export function omarchyThemeArgument(theme: OmarchyTheme): string {
  return ARGUMENT + encodeURIComponent(JSON.stringify(theme));
}

/**
 * The Omarchy theme a window starts in. `choice` is the saved theme preference (`pi-kit.theme` in the UI preferences): with an
 * explicit theme chosen the window gets none, so its first paint is not in colours the page replaces a moment later.
 */
export function startingOmarchyTheme(
  theme: OmarchyTheme | undefined,
  choice: string | undefined,
): OmarchyTheme | undefined {
  return choice === undefined || choice === 'system' ? theme : undefined;
}

/** The theme a window was created with; `undefined` without one, or when the argument is not what main writes. */
export function omarchyThemeFromArguments(argv: readonly string[]): OmarchyTheme | undefined {
  const argument = argv.find((value) => value.startsWith(ARGUMENT));
  if (!argument) return undefined;
  try {
    return asOmarchyTheme(JSON.parse(decodeURIComponent(argument.slice(ARGUMENT.length))));
  } catch {
    return undefined;
  }
}

/** Accepts only a theme whose every token is a custom property with a `#rrggbb` value: the page writes them into its style. */
export function asOmarchyTheme(value: unknown): OmarchyTheme | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { name, mode, tokens } = value as Record<string, unknown>;
  if (typeof name !== 'string' || (mode !== 'dark' && mode !== 'light')) return undefined;
  if (!tokens || typeof tokens !== 'object') return undefined;
  const entries = Object.entries(tokens);
  const valid = entries.every(
    ([token, color]) => /^--[a-z0-9-]+$/.test(token) && typeof color === 'string' && /^#[0-9a-f]{6}$/.test(color),
  );
  return valid ? { name, mode, tokens: Object.fromEntries(entries) as Record<string, string> } : undefined;
}
