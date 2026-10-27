import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./mac-keychain', () => ({
  MacKeychainSecretStore: vi.fn(class {
    available = vi.fn(() => true);
    get = vi.fn(() => 'mock-only');
  }),
}));
import { MacKeychainSecretStore } from './mac-keychain';
import { KeyringSecretStore, NoSecretStore, selectSecretStore } from './store';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('explicit macOS opt-in', () => {
  it('unset and empty never construct or query a native store', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const available = vi.spyOn(KeyringSecretStore.prototype, 'available').mockImplementation(() => { throw new Error('Native load forbidden'); });
    for (const env of [{}, { PI_KIT_SECRET_STORE: '' }]) {
      const store = selectSecretStore(env, true);
      expect(store).toBeInstanceOf(NoSecretStore);
      expect(store.available()).toBe(false);
      expect(store.get('openrouter')).toBeUndefined();
      expect(store.list()).toEqual([]);
    }
    expect(MacKeychainSecretStore).not.toHaveBeenCalled();
    expect(available).not.toHaveBeenCalled();
  });

  it('selects explicit macos using only a mocked implementation', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const env = { PI_KIT_SECRET_STORE: 'macos' };
    const store = selectSecretStore(env, true);
    expect(MacKeychainSecretStore).toHaveBeenCalledWith(env);
    expect(store.get('openrouter')).toBe('mock-only');
  });

  it('preserves explicit legacy without probing it and rejects unknown values safely', () => {
    expect(selectSecretStore({ PI_KIT_SECRET_STORE: 'legacy' }, true)).toBeInstanceOf(KeyringSecretStore);
    for (const setting of ['typo', 'macOS', ' private-value ']) {
      expect(() => selectSecretStore({ PI_KIT_SECRET_STORE: setting }, true)).toThrow(/Unknown PI_KIT_SECRET_STORE setting/);
      try { selectSecretStore({ PI_KIT_SECRET_STORE: setting }, true); } catch (error) {
        expect((error as Error).message).not.toContain(setting);
      }
    }
  });
});
