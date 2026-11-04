/** localStorage that may be absent or blocked; reads fall back to nothing and writes are best effort. */
export class SiteStorage {
  static readonly ADDRESS = 'pi-kit.remote.address';
  static readonly LANGUAGE = 'pi-kit.remote.lang';

  static read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  static write(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      return;
    }
  }
}
