import { prepareUiStorage, readStorage, writeStorage } from './with-persistence';

afterEach(async () => {
  delete window.piKit;
  await prepareUiStorage();
  vi.restoreAllMocks();
});

it('reads and updates the desktop cache without synchronously opening browser storage', async () => {
  const set = vi.fn(async () => undefined);
  window.piKit = {
    getBackendUrl: async () => '',
    getToken: async () => '',
    getUiStorage: async () => ({ 'pi-kit.theme': 'pi-light', 'pk.graph.fold.thread': '0' }),
    setUiStorage: set,
  };
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('blocking read');
  });
  const put = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocking write');
  });
  await prepareUiStorage();
  expect(readStorage('pi-kit.theme')).toBe('pi-light');
  expect(readStorage('pk.graph.fold.thread')).toBe('0');
  writeStorage('pi-kit.theme', 'pi-dark');
  expect(readStorage('pi-kit.theme')).toBe('pi-dark');
  expect(set).toHaveBeenCalledWith('pi-kit.theme', 'pi-dark');
  expect(get).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});
