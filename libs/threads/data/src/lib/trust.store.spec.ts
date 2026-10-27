import { TestBed } from '@angular/core/testing';
import { provideMockApi, settingsDecide, settingsTrustState } from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { TrustState } from '@pi-kit/protocol';
import { TrustStore } from './trust.store';

const state = (status: TrustState['status'], hasResources = true): TrustState =>
  ({ cwd: '/p', status, hasResources }) as TrustState;

describe('TrustStore', () => {
  const api = { trust: vi.fn(), decideTrust: vi.fn() };
  const make = () => TestBed.inject(TrustStore);

  beforeEach(() => {
    api.trust.mockReset();
    api.decideTrust.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [settingsTrustState, api.trust, (o) => [o.path?.['id']]],
          [settingsDecide, api.decideTrust, (o) => [o.path?.['id'], o.body?.['decision']]],
        ]),
      ],
    });
  });

  it('ensure resolves at once for a folder that has an answer', async () => {
    api.trust.mockResolvedValue(state('trusted'));
    const trust = make();
    await trust.ensure('/p');
    expect(trust.prompt()).toBeUndefined();
  });

  it('ensure does not lock the user out when the state cannot be read', async () => {
    api.trust.mockRejectedValue(new Error('down'));
    await make().ensure('/p');
  });

  it('ensure waits for the answer, and callers for the same folder share it', async () => {
    api.trust.mockResolvedValue(state('ask'));
    api.decideTrust.mockResolvedValue({ ...state('trusted'), reopened: 0, running: 0 });
    const trust = make();
    let first = false;
    let second = false;
    void trust.ensure('/p').then(() => (first = true));
    void trust.ensure('/p').then(() => (second = true));
    await vi.waitFor(() => expect(trust.prompt()?.mode).toBe('first'));
    expect(api.trust).toHaveBeenCalledTimes(1);
    expect(first || second).toBe(false);
    await trust.answer('once');
    await vi.waitFor(() => expect(first && second).toBe(true));
    expect(trust.prompt()).toBeUndefined();
    expect(trust.answered()).toBe(1);
  });

  it('review explains a folder without project resources', async () => {
    api.trust.mockResolvedValue(state('trusted', false));
    const trust = make();
    await trust.review('/p');
    expect(trust.prompt()).toBeUndefined();
    expect(TestBed.inject(ToastStore).items()[0].text).toMatch(/nothing to trust/);
  });

  it('answer says what was remembered, and a failure is a toast', async () => {
    api.trust.mockResolvedValue(state('ask'));
    api.decideTrust.mockResolvedValueOnce({ ...state('trusted'), reopened: 0, running: 1 });
    const trust = make();
    void trust.ensure('/p');
    await vi.waitFor(() => expect(trust.prompt()).toBeDefined());
    await trust.answer('remember');
    const texts = TestBed.inject(ToastStore)
      .items()
      .map((t) => t.text);
    expect(texts[0]).toMatch(/remembered/);
    expect(texts[1]).toMatch(/run is going/);

    api.decideTrust.mockRejectedValueOnce(new Error('nope'));
    void trust.ensure('/q');
    await vi.waitFor(() => expect(trust.prompt()).toBeDefined());
    await trust.answer('never');
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toMatch(/Could not save the answer: nope/);
    expect(trust.busy()).toBe(false);
  });
});
