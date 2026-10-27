import { TestBed } from '@angular/core/testing';
import { ComposerExtensions } from './composer-extensions';

const action = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  icon: '+',
  run: () => undefined,
  ...over,
});

describe('ComposerExtensions', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('splits the toolbar actions by placement and orders them', () => {
    const ext = TestBed.inject(ComposerExtensions);
    ext.addAction(action('b', { order: 20 }));
    ext.addAction(action('a', { order: 10 }));
    ext.addAction(action('r', { placement: 'right' }));
    expect(ext.leftActions().map((a) => a.id)).toEqual(['a', 'b']);
    expect(ext.rightActions().map((a) => a.id)).toEqual(['r']);
  });

  it('a registration with the same id replaces the earlier one, and the returned function removes it', () => {
    const ext = TestBed.inject(ComposerExtensions);
    ext.addAction(action('x', { label: 'one' }));
    const remove = ext.addAction(action('x', { label: 'two' }));
    expect(ext.leftActions().map((a) => a.label)).toEqual(['two']);
    remove();
    expect(ext.leftActions()).toEqual([]);
  });

  it('runs the send pipeline in order', () => {
    const ext = TestBed.inject(ComposerExtensions);
    ext.addTransform({ id: 'files', order: 40, transform: (i) => i });
    ext.addTransform({ id: 'shell', order: 10, transform: (i) => i });
    expect(ext.pipeline().map((t) => t.id)).toEqual(['shell', 'files']);
  });

  it("forgetPi drops what pi extensions added and keeps the app's own", () => {
    const ext = TestBed.inject(ComposerExtensions);
    ext.addAction(action('app', { source: 'app' }));
    ext.addAction(action('ext', { source: 'pi' }));
    ext.addSuggestion({ id: 's1', title: 'Fix', text: 'fix it', source: 'pi' });
    ext.addSuggestion({ id: 's2', title: 'Rerun', text: 'again', source: 'app' });
    ext.forgetPi();
    expect(ext.leftActions().map((a) => a.id)).toEqual(['app']);
    expect(ext.suggestions().map((s) => s.id)).toEqual(['s2']);
    ext.removeSuggestion('s2');
    expect(ext.suggestions()).toEqual([]);
  });
});
