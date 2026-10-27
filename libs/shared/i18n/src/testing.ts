import type { Translate } from './lib/language';
import en from './lib/translations/en.json';
import de from './lib/translations/de.json';

interface Catalog {
  readonly [key: string]: string | Catalog;
}

const fromCatalog =
  (catalog: Catalog): Translate =>
  (key, params = {}) => {
    const value = key
      .split('.')
      .reduce<string | Catalog | undefined>(
        (node, segment) =>
          node && typeof node === 'object' && Object.hasOwn(node, segment) ? node[segment] : undefined,
        catalog,
      );
    if (typeof value !== 'string') throw new Error(`Missing translation: ${key}`);
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(params[name] ?? ''));
  };
export const english = fromCatalog(en);
export const german = fromCatalog(de);
