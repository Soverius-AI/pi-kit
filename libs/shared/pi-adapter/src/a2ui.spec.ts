import { describe, expect, it } from 'vitest';
import { normalizeA2uiOperations } from './a2ui';

const surface = { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'c' } };
const data = (path: string | undefined, value: unknown) => ({ version: 'v0.9', updateDataModel: { surfaceId: 's', ...(path === undefined ? {} : { path }), value } });

describe('normalizeA2uiOperations (the data-model convention)', () => {
  it('turns the array an old extension wrote at /specs into an object at the root', () => {
    const specs = [{ spec: 'a.spec.ts:1' }, { spec: 'b.spec.ts:2' }];
    expect(normalizeA2uiOperations([surface, data('/specs', specs)])).toEqual([surface, data('/', { specs })]);
  });

  it('leaves the new payload (an object at the root, or at a path) exactly as it is', () => {
    const operations = [surface, data('/', { specs: [{ spec: 'a' }] }), data('/filters', { open: true }), data(undefined, { specs: [] })];
    expect(normalizeA2uiOperations(operations)).toEqual(operations);
  });

  it('moves a nested bare value to its parent and keeps the escapes of the pointer', () => {
    expect(normalizeA2uiOperations([data('/a/b', [1])])).toEqual([data('/a', { b: [1] })]);
    expect(normalizeA2uiOperations([data('/a/b/c', 'x')])).toEqual([data('/a/b', { c: 'x' })]);
    expect(normalizeA2uiOperations([data('/a~1b/c~0d', 3)])).toEqual([data('/a~1b', { 'c~d': 3 })]);
    expect(normalizeA2uiOperations([data('/a/b~1c', false)])).toEqual([data('/a', { 'b/c': false })]);
  });

  it('does not touch a delete (null or no value), a root update, a relative path or other operations', () => {
    const operations = [surface, data('/x', null), data('/y', undefined), data('/', [1]), data('x', [1]), data('', 'text'), { version: 'v0.9', deleteSurface: { surfaceId: 's' } }];
    expect(normalizeA2uiOperations(operations)).toEqual(operations);
  });

  it('does not modify its input', () => {
    const input = [data('/specs', [1])];
    const copy = structuredClone(input);
    normalizeA2uiOperations(input);
    expect(input).toEqual(copy);
  });
});
