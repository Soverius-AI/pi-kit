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
    if (/^pi-(dark|light|soverius|copilotkit|omarchy)$/.test(theme))
      document.documentElement.setAttribute('data-theme', theme);
  } catch {
    /* Storage is blocked: the default theme stays until the app applies the saved one. */
  }
})();
