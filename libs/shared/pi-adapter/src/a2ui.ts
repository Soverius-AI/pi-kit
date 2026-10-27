import type { A2uiOperation } from '@pi-kit/protocol';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A JSON pointer's segments, unescaped (`~1` is `/`, `~0` is `~`); `undefined` for anything that is not an absolute pointer. */
function segmentsOf(path: unknown): string[] | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
  return path
    .split('/')
    .slice(1)
    .filter((segment) => segment !== '')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

const pointerOf = (segments: string[]): string => (segments.length === 0 ? '/' : `/${segments.map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`);

/**
 * The data-model convention: a surface's data lives in an object, so an
 * `updateDataModel` carries an object `value`. CopilotKit's A2UI renderer keeps a surface behind a loader until it has seen
 * a data update whose `value` is an object with something in it, because a surface that binds data paths is empty
 * until then; an extension that wrote the array itself (`{ path: '/specs', value: [...] }`, how the first extension example did it)
 * would wait the 8 seconds the loader allows.
 *
 * So a bare value, an array or a string, number or boolean (`null` deletes the key and stays as it is), at an absolute
 * path becomes the object at the parent path: `{ path: '/specs', value: [..] }` is `{ path: '/', value: { specs: [..] } }`
 * and `{ path: '/a/b', value: 1 }` is `{ path: '/a', value: { b: 1 } }`. Everything that is already an object, a root
 * update and every other operation passes through untouched, and the input is not modified. The update then replaces the
 * parent object, as every A2UI update replaces what is at its path, so a surface that sets several siblings one by
 * one writes them as one object.
 */
export function normalizeA2uiOperations(operations: readonly A2uiOperation[]): A2uiOperation[] {
  return operations.map((operation) => {
    const update = operation['updateDataModel'];
    if (!isRecord(update)) return operation;
    const value = update['value'];
    if (value === undefined || value === null || isRecord(value)) return operation;
    const segments = segmentsOf(update['path']);
    if (!segments || segments.length === 0) return operation;
    const last = segments[segments.length - 1] as string;
    return { ...operation, updateDataModel: { ...update, path: pointerOf(segments.slice(0, -1)), value: { [last]: value } } };
  });
}
