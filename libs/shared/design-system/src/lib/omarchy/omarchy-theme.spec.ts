/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import postcss, { type ChildNode, type Node, type AtRule } from 'postcss';
import { describe, expect, it } from 'vitest';

const localPath = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const source = (path: string) => readFileSync(localPath(path), 'utf8');
const skin = postcss.parse(source('../../omarchy.css'));
const paletteSelector = ":root[data-theme='pi-omarchy']";
const backdropRules: Record<string, Record<string, string>> = {
  "[data-theme='pi-omarchy'] .pk-shell.pk-has-pixel-field": { position: 'relative', isolation: 'isolate' },
  "[data-theme='pi-omarchy'] .pk-theme-backdrop": { 'grid-area': 'main' },
};

function inKeyframes(node: ChildNode): boolean {
  for (let parent: Node | undefined = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && /keyframes$/i.test((parent as AtRule).name)) return true;
  }
  return false;
}

function motionOptIn(node: ChildNode): boolean {
  for (let parent: Node | undefined = node.parent; parent; parent = parent.parent) {
    if (
      parent.type === 'atrule' &&
      (parent as AtRule).name === 'media' &&
      /^\(prefers-reduced-motion:\s*no-preference\)$/.test((parent as AtRule).params)
    )
      return true;
  }
  return false;
}

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = hex
      .slice(1)
      .match(/../g)!
      .map((value) => {
        const channel = parseInt(value, 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('Omarchy skin safety', () => {
  it('pins the approved Last Horizon palette and mono-first font tokens', () => {
    const values: Record<string, string> = {};
    skin.walkRules((rule) => {
      if (rule.selector !== ":root[data-theme='pi-omarchy']") return;
      rule.walkDecls((declaration) => {
        values[declaration.prop] = declaration.value;
      });
    });
    const palette = {
      '--color-base-100': '#171416',
      '--color-base-200': '#0c0b0c',
      '--color-base-300': '#3a3234',
      '--color-base-content': '#fafcfb',
      '--color-primary': '#b59790',
      '--color-secondary': '#cbb6b1',
      '--color-accent': '#b59790',
      '--color-neutral': '#090809',
      '--color-neutral-content': '#fafcfb',
      '--color-info': '#cbb6b1',
      '--color-success': '#a9c28a',
      '--color-warning': '#d5b382',
      '--color-error': '#ed9ba4',
      '--pk-muted': '#a9a5a6',
      '--pk-sunken': '#090809',
      '--pk-omarchy-border': '#584e51',
    };
    for (const [token, value] of Object.entries(palette)) expect(values[token], token).toBe(value);
    for (const role of ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error']) {
      expect(values[`--color-${role}-content`], role).toBe('#0c0e10');
    }
    const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
    expect(values['--pk-font-sans']).toBe(mono);
    expect(values['--pk-font-mono']).toBe(mono);
    expect(values['--pk-font-prose']).toBeUndefined();
    expect(values['--pk-pixel-color']).toBe('var(--color-primary)');
    expect(values['--pk-pixel-dim']).toBe('var(--color-base-300)');
    expect(values['--pk-pixel-mid']).toBe('color-mix(in srgb, var(--color-primary) 50%, var(--color-base-300))');
    expect(values['--pk-pixel-cell']).toBe('16');
    expect(values['--pk-pixel-opacity']).toBe('0.85');
    expect(values['--pk-pixel-speed']).toBe('1.4');
    expect(values['--pk-pixel-pointer-radius']).toBe('160');
    expect(values['--pk-pixel-pointer-gain']).toBe('0.85');
    skin.walkDecls(/^--pk-pixel-/, (declaration) => {
      expect(declaration.parent?.type).toBe('rule');
      expect((declaration.parent as { selector?: string }).selector).toBe(":root[data-theme='pi-omarchy']");
    });
    skin.walkDecls('font-family', (declaration) => {
      expect(declaration.value).not.toMatch(/Geist|font-prose/);
    });
  });

  it('scopes every non-keyframe selector to the named theme', () => {
    let count = 0;
    skin.walkRules((rule) => {
      if (inKeyframes(rule)) return;
      count++;
      for (const selector of rule.selectors) {
        expect(selector, selector).toMatch(
          /^(?:\[data-theme=['"]pi-omarchy['"]\](?:\s|$)|:root\[data-theme=['"]pi-omarchy['"]\]$|:root\[data-pk-theme-transition=['"]omarchy['"]\]::view-transition-(?:group|old|new)\(root\)$)/,
        );
      }
    });
    expect(count).toBeGreaterThan(0);
  });

  it('owns its palette and font faces without scattering definitions into shared stylesheets', () => {
    expect(source('../../tokens.css')).not.toContain(paletteSelector);
    expect(source('../../fonts.css')).not.toContain('JetBrains Mono');
  });

  it('pins the backdrop integration without changing grid tracks or component dimensions', () => {
    for (const [selector, expected] of Object.entries(backdropRules)) {
      let found: Record<string, string> | undefined;
      skin.walkRules((rule) => {
        if (rule.selector === selector) {
          found = Object.fromEntries(
            rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
          );
        }
      });
      expect(found, selector).toEqual(expected);
    }
  });

  it('changes only paint, fonts and motion outside the exact backdrop integration', () => {
    const allowed =
      /^(?:font-family|color|background(?:-color|-image|-size|-repeat|-position)?|border-color|mask-image|mix-blend-mode|clip-path|opacity|transform|scale|animation(?:-[a-z-]+)?|transition(?:-[a-z-]+)?)$/;
    skin.walkDecls((declaration) => {
      const parent = declaration.parent;
      if (parent?.type === 'atrule' && (parent as AtRule).name === 'font-face') return;
      const selector = parent?.type === 'rule' ? (parent as { selector: string }).selector : '';
      if (selector === paletteSelector) {
        expect(declaration.prop).toMatch(
          /^(?:color-scheme|--color-[a-z0-9-]+|--pk-(?:muted|sunken|omarchy-border|shadow|font-(?:sans|mono)|pixel-[a-z-]+))$/,
        );
        return;
      }
      if (backdropRules[selector]) {
        expect(declaration.value).toBe(backdropRules[selector][declaration.prop]);
        return;
      }
      expect(declaration.prop, declaration.toString()).toMatch(allowed);
      if (inKeyframes(declaration)) {
        expect(declaration.prop).toMatch(/^(?:opacity|transform|background-position|clip-path)$/);
      }
    });
  });

  it('opts into all added motion only when reduced motion is not requested', () => {
    skin.walkDecls((declaration) => {
      if (inKeyframes(declaration)) return;
      if (!/^(?:animation|transition|transform|scale)(?:-|$)/.test(declaration.prop)) return;
      if (declaration.value === 'none') return;
      expect(motionOptIn(declaration), declaration.toString()).toBe(true);
    });
  });

  it('never adds motion to transcript turns, streaming text or virtual rows', () => {
    skin.walkRules((rule) => {
      if (inKeyframes(rule)) return;
      const motion = rule.nodes.some(
        (node) => node.type === 'decl' && /^(?:animation|transition|transform|scale)(?:-|$)/.test(node.prop),
      );
      if (!motion) return;
      expect(rule.selector).not.toMatch(
        /transcript|stream|virtual|pk-turn|pk-user|pk-prose|pk-activity|pk-graph-row|pk-work/,
      );
      // An allowlist also catches broad selectors that could animate live content indirectly.
      expect(rule.selector).toMatch(
        /(?:\.(?:pk-header|pk-ambient|pk-empty-state|pk-picker|pk-popover|pk-usage-pop|pk-where-menu|pk-settings|pk-wf|pk-shell|btn|pk-send)(?=[\s.:,)>]|\[|$)|::view-transition-(?:group|old|new)\(root\))/,
      );
    });
  });

  it('keeps the signature motion visible beyond the empty screen', () => {
    const animations = new Map<string, string>();
    skin.walkRules((rule) => {
      if (inKeyframes(rule)) return;
      rule.walkDecls('animation', (declaration) => {
        if (motionOptIn(declaration)) animations.set(rule.selector, declaration.value);
      });
    });
    expect(animations.get("[data-theme='pi-omarchy'] .pk-header")).toBe('pk-omarchy-signal 5s steps(32, end) infinite');
    expect(animations.get("[data-theme='pi-omarchy'] .pk-ambient::after")).toBe(
      'pk-omarchy-pixels 6s steps(18, end) infinite alternate',
    );
    expect(animations.get(":root[data-pk-theme-transition='omarchy']::view-transition-new(root)")).toBe(
      'pk-omarchy-screen-in 520ms steps(12, end) both',
    );
    const panel = [...animations].find(([selector]) => selector.includes(' > .pk-panel'));
    expect(panel?.[0]).toContain(':not(pk-artifacts-panel, pk-terminal-panel)');
    expect(panel?.[1]).toContain('pk-omarchy-panel 300ms');
  });

  it('bundles all four Omarchy subsets as real local WOFF2 fonts with OFL licenses', () => {
    const expected = [
      'jetbrains-mono-latin.woff2',
      'jetbrains-mono-latin-ext.woff2',
      'jetbrains-mono-latin-italic.woff2',
      'jetbrains-mono-latin-ext-italic.woff2',
    ];
    const found: string[] = [];
    skin.walkAtRules('font-face', (face) => {
      const declarations = Object.fromEntries(
        (face.nodes ?? []).filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
      );
      expect(declarations['font-family']).not.toMatch(/Geist/);
      if (!/^['"]JetBrains Mono['"]$/.test(declarations['font-family'])) return;
      const match = /^url\(['"]?\.\/fonts\/([^'"/)]+)['"]?\) format\(['"]woff2['"]\)$/.exec(declarations['src']);
      expect(match, declarations['src']).not.toBeNull();
      const name = match![1];
      found.push(name);
      const bytes = readFileSync(localPath(`../../fonts/${name}`));
      expect(bytes.toString('ascii', 0, 4)).toBe('wOF2');
      expect(bytes.readUInt32BE(8)).toBe(bytes.length);
      expect(bytes.readUInt16BE(12)).toBeGreaterThan(0);
      expect(bytes.length).toBeGreaterThan(1000);
      expect(Object.keys(declarations).sort()).toEqual(
        ['font-family', 'src', 'font-style', 'font-weight', 'font-display', 'unicode-range'].sort(),
      );
      expect(declarations['font-weight']).toBe('100 800');
      expect(declarations['font-style']).toBe(name.includes('italic') ? 'italic' : 'normal');
      expect(declarations['font-display']).toBe('swap');
      expect(declarations['unicode-range']).toBeTruthy();
    });
    expect(found.sort()).toEqual(expected.sort());
    expect(source('../../fonts/JetBrainsMono-OFL.txt')).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
  });

  it('keeps normal-surface text and semantic filled foregrounds readable', () => {
    const colors: Record<string, string> = {};
    skin.walkRules((rule) => {
      if (rule.selector !== ":root[data-theme='pi-omarchy']") return;
      rule.walkDecls((declaration) => {
        colors[declaration.prop] = declaration.value;
      });
    });
    // Hairlines also become hover/selection fills in the shared components.
    for (const surface of ['--color-base-100', '--color-base-200', '--color-base-300', '--pk-sunken']) {
      for (const text of ['--color-base-content', '--pk-muted']) {
        expect(contrast(colors[text], colors[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const role of ['primary', 'secondary', 'accent', 'neutral', 'info', 'success', 'warning', 'error']) {
      expect(contrast(colors[`--color-${role}-content`], colors[`--color-${role}`]), role).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('first-paint theme restoration', () => {
  const script = source('../../../../../../apps/renderer/public/theme.js');
  function paint(choice: string | null, light = false, blocked = false, piKit?: object) {
    const attributes: Record<string, string> = {};
    const style: Record<string, string> = {};
    runInNewContext(
      script,
      {
        piKit,
        localStorage: {
          getItem: (key: string) => {
            expect(key).toBe('pi-kit.theme');
            if (blocked) throw new Error('Storage blocked');
            return choice;
          },
        },
        matchMedia: (query: string) => {
          expect(query).toBe('(prefers-color-scheme: light)');
          return { matches: light };
        },
        document: {
          documentElement: {
            setAttribute: (key: string, value: string) => {
              attributes[key] = value;
            },
            style: {
              setProperty: (name: string, value: string) => {
                style[name] = value;
              },
            },
          },
        },
      },
      { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } },
    );
    return { attributes, style };
  }
  const restore = (choice: string | null, light = false, blocked = false) =>
    paint(choice, light, blocked).attributes['data-theme'];

  it.each(['pi-omarchy', 'pi-dark', 'pi-light', 'pi-soverius', 'pi-copilotkit'])(
    'restores %s before app bootstrap',
    (theme) => {
      expect(restore(theme)).toBe(theme);
    },
  );
  it('resolves system and missing choices using the OS preference', () => {
    expect(restore('system', true)).toBe('pi-light');
    expect(restore(null)).toBe('pi-dark');
  });
  it('paints System in the desktop’s own colours when the desktop app names them', () => {
    const piKit = {
      omarchyTheme: { name: 'catppuccin-latte', mode: 'light', tokens: { '--color-primary': '#1e66f5' } },
    };
    expect(paint('system', false, false, piKit)).toEqual({
      attributes: { 'data-theme': 'pi-desktop', 'data-scheme': 'light' },
      style: { '--color-primary': '#1e66f5' },
    });
    expect(paint('pi-omarchy', false, false, piKit)).toEqual({ attributes: { 'data-theme': 'pi-omarchy' }, style: {} });
  });
  it('leaves the default alone for unknown choices or blocked storage', () => {
    expect(restore('pi-unrecognized')).toBeUndefined();
    expect(restore('pi-omarchy', false, true)).toBeUndefined();
  });
});
