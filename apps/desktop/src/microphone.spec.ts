import { describe, expect, it, vi } from 'vitest';
import { requestMicrophone, type MediaAccess } from './microphone';

const access = (statuses: string[], ask: boolean): MediaAccess & { asked: number } => {
  let asked = 0;
  return {
    get asked() {
      return asked;
    },
    getMediaAccessStatus: () => statuses.shift() ?? 'denied',
    askForMediaAccess: async () => {
      asked++;
      return ask;
    },
  };
};

describe('requestMicrophone', () => {
  it('has nothing to ask on other systems', async () => {
    const explain = vi.fn();
    for (const platform of ['win32', 'linux'] as const) {
      expect(await requestMicrophone(platform, access(['denied'], false), explain)).toEqual({ granted: true, status: 'granted' });
    }
    expect(explain).not.toHaveBeenCalled();
  });

  it('on a Mac that already allowed it, asks nothing', async () => {
    const mic = access(['granted'], false);
    const explain = vi.fn();
    expect(await requestMicrophone('darwin', mic, explain)).toEqual({ granted: true, status: 'granted' });
    expect(mic.asked).toBe(0);
    expect(explain).not.toHaveBeenCalled();
  });

  it('asks the system the first time, and goes ahead when the user says yes', async () => {
    const mic = access(['not-determined'], true);
    const explain = vi.fn();
    expect(await requestMicrophone('darwin', mic, explain)).toEqual({ granted: true, status: 'granted' });
    expect(mic.asked).toBe(1);
    expect(explain).not.toHaveBeenCalled();
  });

  it('explains a refusal, and says where to undo it', async () => {
    const mic = access(['not-determined', 'denied'], false);
    const explain = vi.fn(async () => undefined);
    const result = await requestMicrophone('darwin', mic, explain);
    expect(result).toMatchObject({ granted: false, status: 'denied' });
    expect(result.message).toMatch(/System Settings/);
    expect(explain).toHaveBeenCalledWith('denied');
    // A refusal made earlier is not asked again (macOS would not show the prompt): only explained.
    const earlier = access(['denied'], true);
    expect((await requestMicrophone('darwin', earlier, explain)).granted).toBe(false);
    expect(earlier.asked).toBe(0);
  });

  it('a restricted microphone cannot be fixed by the user in System Settings', async () => {
    const result = await requestMicrophone('darwin', access(['restricted'], false), async () => undefined);
    expect(result).toMatchObject({ granted: false, status: 'restricted' });
    expect(result.message).toMatch(/restricted/);
  });
});
