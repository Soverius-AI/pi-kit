import { createThemeTransition } from './theme-transition';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nativeTransition() {
  const finished = deferred();
  const ready = deferred();
  const updated = deferred();
  return {
    finished,
    ready,
    updated,
    api: {
      finished: finished.promise,
      ready: ready.promise,
      updateCallbackDone: updated.promise,
      skipTransition: vi.fn(),
    },
  };
}

describe('theme transition', () => {
  let coordinator: ReturnType<typeof createThemeTransition>;
  let reduced: boolean;
  let start: ReturnType<typeof vi.fn>;
  let transitions: ReturnType<typeof nativeTransition>[];
  let callbacks: (() => void)[];
  const root = document.documentElement;
  const theme = () => root.getAttribute('data-theme');
  const marker = () => root.getAttribute('data-pk-theme-transition');

  beforeEach(() => {
    reduced = false;
    transitions = [];
    callbacks = [];
    root.removeAttribute('data-theme');
    root.removeAttribute('data-pk-theme-transition');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: reduced })),
    );
    start = vi.fn((callback: () => void) => {
      const transition = nativeTransition();
      transitions.push(transition);
      callbacks.push(callback);
      return transition.api;
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    coordinator = createThemeTransition(document);
  });

  afterEach(() => {
    coordinator.destroy();
    Reflect.deleteProperty(document, 'startViewTransition');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not animate restoration, even with an existing DOM theme, or no-ops', () => {
    root.setAttribute('data-theme', 'pi-dark');
    coordinator.apply('pi-omarchy');
    coordinator.apply('pi-omarchy');
    expect(theme()).toBe('pi-omarchy');
    expect(start).not.toHaveBeenCalled();
    expect(marker()).toBeNull();
  });

  it.each(['pi-dark', 'pi-light', 'pi-soverius', 'pi-copilotkit'] as const)(
    'animates entering from and exiting to %s, committing only when the native callback runs',
    async (standard) => {
      coordinator.apply(standard);
      coordinator.apply('pi-omarchy');
      expect(marker()).toBe('omarchy');
      expect(theme()).toBe(standard);
      callbacks[0]();
      expect(theme()).toBe('pi-omarchy');
      transitions[0].finished.resolve();
      await Promise.resolve();
      expect(marker()).toBeNull();
      coordinator.apply(standard);
      callbacks[1]();
      expect(theme()).toBe(standard);
      transitions[1].finished.resolve();
      await Promise.resolve();
      expect(marker()).toBeNull();
    },
  );

  it('does not animate between standard themes', () => {
    coordinator.apply('pi-dark');
    coordinator.apply('pi-soverius');
    coordinator.apply('pi-copilotkit');
    expect(theme()).toBe('pi-copilotkit');
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'reduced', 'hidden', 'media error'] as const)('applies immediately when %s', (reason) => {
    coordinator.apply('pi-dark');
    if (reason === 'unsupported') Reflect.deleteProperty(document, 'startViewTransition');
    if (reason === 'reduced') reduced = true;
    if (reason === 'hidden') vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    if (reason === 'media error')
      vi.stubGlobal('matchMedia', () => {
        throw new Error('media unavailable');
      });
    coordinator.apply('pi-omarchy');
    expect(theme()).toBe('pi-omarchy');
    expect(marker()).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('falls back when the browser throws while starting', () => {
    start.mockImplementation(() => {
      throw new Error('unavailable');
    });
    coordinator.apply('pi-dark');
    coordinator.apply('pi-omarchy');
    expect(theme()).toBe('pi-omarchy');
    expect(marker()).toBeNull();
  });

  it('handles rejected native promises without leaving the marker or dropping the theme', async () => {
    coordinator.apply('pi-dark');
    coordinator.apply('pi-omarchy');
    transitions[0].ready.reject(new Error('skipped'));
    transitions[0].updated.reject(new Error('update failed'));
    transitions[0].finished.reject(new Error('failed'));
    await Promise.resolve();
    expect(theme()).toBe('pi-omarchy');
    expect(marker()).toBeNull();
  });

  it('skips pending transitions and ignores stale callbacks and cleanup', async () => {
    coordinator.apply('pi-dark');
    coordinator.apply('pi-omarchy');
    coordinator.apply('pi-light');
    expect(transitions[0].api.skipTransition).toHaveBeenCalledOnce();
    callbacks[0]();
    expect(theme()).toBe('pi-dark');
    transitions[0].finished.reject(new Error('skipped'));
    transitions[0].updated.reject(new Error('skipped'));
    transitions[0].ready.reject(new Error('skipped'));
    await Promise.resolve();
    expect(marker()).toBe('omarchy');
    callbacks[1]();
    expect(theme()).toBe('pi-light');
    coordinator.apply('pi-soverius');
    expect(transitions[1].api.skipTransition).toHaveBeenCalledOnce();
    callbacks[1]();
    expect(theme()).toBe('pi-soverius');
    expect(marker()).toBeNull();
  });

  it('does not cancel a running transition on a duplicate apply', () => {
    coordinator.apply('pi-dark');
    coordinator.apply('pi-omarchy');
    coordinator.apply('pi-omarchy');
    expect(start).toHaveBeenCalledOnce();
    expect(transitions[0].api.skipTransition).not.toHaveBeenCalled();
    callbacks[0]();
    expect(theme()).toBe('pi-omarchy');
  });

  it('skips on destruction and prevents late callbacks from applying themes', async () => {
    coordinator.apply('pi-dark');
    coordinator.apply('pi-omarchy');
    coordinator.destroy();
    expect(transitions[0].api.skipTransition).toHaveBeenCalledOnce();
    expect(marker()).toBeNull();
    callbacks[0]();
    transitions[0].finished.resolve();
    await Promise.resolve();
    coordinator.apply('pi-light');
    expect(theme()).toBe('pi-dark');
    expect(marker()).toBeNull();
  });
});
