import { z } from 'zod';

/**
 * The secret mark. A schema, or one field of an object schema, that carries a key or a token says so with
 * `.meta({ secret: true })`; the backend derives from the mark what may be logged (`redactSecrets`), so there is no list of routes
 * to keep in step with the schemas. The mark changes nothing about validation, and the OpenAPI document shows it as `writeOnly`.
 */
declare module 'zod' {
  interface GlobalMeta {
    /** The value is a key, a token or another secret: it is never logged, echoed or returned. */
    secret?: boolean;
  }
}

/** What stands in the log for a value that must not be printed. */
export const SECRET_PLACEHOLDER = '[secret]';

/** Whether the schema itself is marked (an `optional()` or `nullable()` wrapper is looked through). */
export function isSecretSchema(schema: unknown): boolean {
  let current = schema as z.core.$ZodType | undefined;
  for (let depth = 0; current && depth < 8; depth++) {
    if (z.globalRegistry.get(current)?.secret === true) return true;
    const def = current._zod?.def as { innerType?: z.core.$ZodType } | undefined;
    current = def?.innerType;
  }
  return false;
}

const containsSecretCache = new WeakMap<object, boolean>();

/** Whether the schema, or anything inside it, carries the mark. */
export function containsSecret(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const cached = containsSecretCache.get(schema);
  if (cached !== undefined) return cached;
  containsSecretCache.set(schema, false); // a recursive schema ends here
  const def = (schema as z.core.$ZodType)._zod?.def as
    | { shape?: Record<string, unknown>; element?: unknown; innerType?: unknown; options?: unknown[]; in?: unknown; out?: unknown; valueType?: unknown; items?: unknown[] }
    | undefined;
  const parts = [def?.element, def?.innerType, def?.in, def?.out, def?.valueType, ...(def?.options ?? []), ...(def?.items ?? []), ...Object.values(def?.shape ?? {})];
  const found = isSecretSchema(schema) || parts.some((part) => containsSecret(part));
  containsSecretCache.set(schema, found);
  return found;
}

/**
 * A copy of `value` that is safe to print: every field the schema marks is replaced by `[secret]`, and so is every field the schema does
 * not describe (a value that did not validate is not trusted to be harmless). A schema with no mark in it returns the value as it is.
 */
export function redactSecrets(schema: unknown, value: unknown): unknown {
  if (isSecretSchema(schema)) return value === undefined ? undefined : SECRET_PLACEHOLDER;
  if (!containsSecret(schema)) return value;
  const def = (schema as z.core.$ZodType)._zod?.def as { shape?: Record<string, unknown>; element?: unknown; innerType?: unknown; options?: unknown[] } | undefined;
  if (def?.innerType) return redactSecrets(def.innerType, value);
  if (def?.element && Array.isArray(value)) return value.map((item) => redactSecrets(def.element, item));
  if (def?.shape && value && typeof value === 'object' && !Array.isArray(value)) {
    const shape = def.shape;
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, key in shape ? redactSecrets(shape[key], field) : SECRET_PLACEHOLDER]));
  }
  // A union, a pipe or anything else with a mark somewhere inside: the shape of the value is not known, so none of it is printed.
  return value === undefined ? undefined : SECRET_PLACEHOLDER;
}
