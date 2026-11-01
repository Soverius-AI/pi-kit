import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendConfig } from '../app/config';
import type { AppUpdateAction, AppUpdateResult, DesktopBridge } from '../desktop/desktop-bridge';
import type { PiUpdateService } from '../pi/pi-update.service';
import { UpdateService } from './update.service';

// The backend loads pi through a native `import()` that the test runner does not offer.
vi.mock('../pi/load-pi', async (importOriginal) => ({ ...(await importOriginal<typeof import('../pi/load-pi')>()), loadPi: () => import('@earendil-works/pi-coding-agent') }));

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-update-')));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'));
  vi.stubEnv('PI_KIT_DATA_DIR', dir);
  vi.stubEnv('PI_KIT_LOG_DIR', dir);
  vi.stubEnv('PI_OFFLINE', undefined);
  vi.stubEnv('PI_SKIP_VERSION_CHECK', undefined);
});
afterEach(() => vi.unstubAllEnvs());

/**
 * Electron main with pi-kit 99.0.0 published; `download` is what its download answers. A second download withdraws the release,
 * so a retry loop ends after one extra round and the count shows it.
 */
function desktop(download: () => Promise<AppUpdateResult>) {
  const downloads = (): number => appUpdate.mock.calls.filter(([action]) => action === 'download').length;
  const appUpdate = vi.fn((action: AppUpdateAction): Promise<AppUpdateResult> =>
    action === 'download' ? download() : Promise.resolve(downloads() < 2 ? { available: true, version: '99.0.0' } : { available: false }),
  );
  const bridge = { available: true, onAppUpdate: () => () => undefined, appUpdate } as unknown as DesktopBridge;
  return { bridge, downloads };
}

const service = (bridge: DesktopBridge): UpdateService =>
  new UpdateService({ check: () => Promise.resolve({}) } as unknown as PiUpdateService, bridge, { dataDir: dir, defaultCwd: dir } as BackendConfig);

/** Waits for the job a check started and for the check every job ends with. */
async function settle(updates: UpdateService): Promise<void> {
  await updates.idle();
  await vi.waitFor(() => expect(updates.status().checking).toBe(false), { timeout: 10_000 });
  await updates.idle();
}

describe('automatic pi-kit downloads', () => {
  it('downloads a newer pi-kit only once the user allows it, and keeps the choice', async () => {
    const { bridge, downloads } = desktop(() => Promise.resolve({ available: true, version: '99.0.0', downloaded: true }));
    const updates = service(bridge);
    await updates.check();
    expect(downloads()).toBe(0);

    updates.setAutoDownload(true);
    await settle(updates);
    expect(downloads()).toBe(1);
    expect(updates.status().restart).toContainEqual({ kind: 'app', version: '99.0.0' });
    expect(service(bridge).status().autoDownload).toBe(true);
  });

  it('does not start the failed download again with every check', async () => {
    const { bridge, downloads } = desktop(() => Promise.reject(new Error('connection reset')));
    const updates = service(bridge);
    updates.setAutoDownload(true);
    await updates.check();
    await settle(updates);
    expect(downloads()).toBe(1);
  });
});
