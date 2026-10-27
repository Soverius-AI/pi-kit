import { describe, expect, it, vi } from 'vitest';
import { emptyBrowserState, type BrowserAction } from '@pi-kit/protocol';
import { BrowserService } from './browser.service';

function setup(saved: Record<string, unknown> = {}) {
  const browser = vi.fn(async () => ({ state: emptyBrowserState('thread', true) }));
  const service = new BrowserService(
    { available: true, browser } as never,
    { get: () => ({ id: 'thread' }) } as never,
    {} as never,
    { getSetting: (key: string) => saved[key] } as never,
  );
  return { service, browser };
}

describe('browser screenshot preferences', () => {
  it('applies saved encoding preferences to agent screenshots without changing the requested area', async () => {
    const { service, browser } = setup({ screenshotFormat: 'png', screenshotQuality: 45 });
    await service.run('thread', { action: 'screenshot', scope: 'fullpage' });
    expect(browser).toHaveBeenCalledWith('thread', { action: 'screenshot', scope: 'fullpage', format: 'png', quality: 45 }, undefined);
  });

  it('honors per-capture overrides including zero JPEG quality', async () => {
    const { service, browser } = setup({ screenshotFormat: 'png', screenshotQuality: 90 });
    const signal = new AbortController().signal;
    const action: BrowserAction = { action: 'screenshot', scope: 'viewport', format: 'jpeg', quality: 0 };
    await service.run('thread', action, signal);
    expect(browser).toHaveBeenCalledWith('thread', action, signal);
  });

  it.each([{}, { screenshotFormat: 'gif', screenshotQuality: 101 }])('uses JPEG quality 80 when saved settings are missing or invalid: %j', async (saved) => {
    const { service, browser } = setup(saved);
    await service.run('thread', { action: 'screenshot' });
    expect(browser).toHaveBeenCalledWith('thread', { action: 'screenshot', format: 'jpeg', quality: 80 }, undefined);
  });

  it('leaves other browser actions alone', async () => {
    const { service, browser } = setup({ screenshotFormat: 'png' });
    await service.run('thread', { action: 'snapshot' });
    expect(browser).toHaveBeenCalledWith('thread', { action: 'snapshot' }, undefined);
  });
});
