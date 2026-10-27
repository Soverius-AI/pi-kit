import { bootstrapApplication } from '@angular/platform-browser';
import { createBackendConnection } from '@pi-kit/api';
import { prepareUiStorage } from '@pi-kit/data-access';
import { App } from './app/app';
import { buildAppConfig } from './app/app.config';

// CopilotKit takes its runtime URL and headers at provide time, and both come from the preload
// (Electron) or the dev token endpoint (browser), so resolve them before bootstrapping. If the
// backend is unreachable the app still starts; the health indicator shows the failure.
async function start(): Promise<void> {
  const backend = createBackendConnection();
  const [url, token] = await Promise.all([backend.url(), backend.token().catch(() => ''), prepareUiStorage()]);
  await bootstrapApplication(App, buildAppConfig({ url, token }, backend));
}

start().catch((err) => console.error(err));
