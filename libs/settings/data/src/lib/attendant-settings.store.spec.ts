import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, settingsModels } from '@pi-kit/api';
import type { SettingsModel } from '@pi-kit/protocol';
import { AttendantSettingsStore } from './attendant-settings.store';
import { SettingsStore } from './settings.store';

const model = (id: string): SettingsModel => ({ provider: 'p', id, name: id, reasoning: false, available: true });

describe('AttendantSettingsStore', () => {
  const models = vi.fn(async () => [model('a')]);

  beforeEach(() => {
    vi.useFakeTimers();
    models.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        AttendantSettingsStore,
        { provide: SettingsStore, useValue: { onProvidersChanged: () => () => undefined } },
        ...provideMockApi([[settingsModels, models, () => []]]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('regression: opened again it shows the last model list at once and still reads it again', async () => {
    const first = TestBed.inject(AttendantSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.models()?.map((m) => m.id)).toEqual(['a']);
    let finish!: (value: SettingsModel[]) => void;
    models.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const reopened = Injector.create({ providers: [AttendantSettingsStore], parent: TestBed.inject(Injector) }).get(
      AttendantSettingsStore,
    );
    expect(reopened.models()?.map((m) => m.id)).toEqual(['a']);
    expect(models).toHaveBeenCalledTimes(2);
    finish([model('a'), model('b')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened.models()?.map((m) => m.id)).toEqual(['a', 'b']);
  });
});
