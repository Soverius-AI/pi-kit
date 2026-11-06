// The stored theme before the first paint: the app bundle applies it only once it has loaded, which on a phone can take seconds.
(() => {
  try {
    const choice = localStorage.getItem('pi-kit.theme');
    const theme =
      choice && choice !== 'system'
        ? choice
        : matchMedia('(prefers-color-scheme: light)').matches
          ? 'pi-light'
          : 'pi-dark';
    const root = document.documentElement;
    // An Omarchy desktop: "System" is the desktop's theme, as ThemeStore applies it later. The desktop app's preload names it,
    // and only while no explicit theme is saved there (its preferences are not in localStorage).
    const omarchy = globalThis.piKit && globalThis.piKit.omarchyTheme;
    if (omarchy && (!choice || choice === 'system')) {
      root.setAttribute('data-theme', 'pi-desktop');
      root.setAttribute('data-scheme', omarchy.mode);
      for (const [name, color] of Object.entries(omarchy.tokens)) root.style.setProperty(name, color);
    } else if (/^pi-(dark|light|soverius|copilotkit|omarchy)$/.test(theme)) root.setAttribute('data-theme', theme);
  } catch {
    /* Storage is blocked: the default theme stays until the app applies the saved one. */
  }
})();
