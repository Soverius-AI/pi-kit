import { bootstrapApplication } from '@angular/platform-browser';
import {
  configureWorkbench,
  createBackendConnection,
  readWorkbenchFragment,
  scopedBackendConnection,
  WorkbenchSelectionSchema,
  type WorkbenchSelection,
} from '@pi-kit/api';
import { prepareUiStorage, readStorage, writeStorage } from '@pi-kit/data-access';
import { EnvironmentSchema } from '@pi-kit/protocol';
import { App } from './app/app';
import { buildAppConfig } from './app/app.config';

// CopilotKit takes its runtime URL and headers at provide time, and both come from the preload
// (Electron) or the dev token endpoint (browser), so resolve them before bootstrapping. If the
// backend is unreachable the app still starts; the health indicator shows the failure.
function currentSelection(): WorkbenchSelection | undefined {
  try {
    const parsed = WorkbenchSelectionSchema.safeParse(
      JSON.parse(readStorage('pi-kit.workbench-ref.v1', 'controller') ?? 'null'),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
async function start(): Promise<void> {
  const entry = createBackendConnection();
  const [entryUrl, token] = await Promise.all([entry.url(), entry.token().catch(() => ''), prepareUiStorage()]);
  const selection = readWorkbenchFragment(location.hash) ?? currentSelection();
  let entryId = readStorage('pi-kit.entryInstance', 'controller') ?? undefined;
  try {
    const response = await fetch(entryUrl + '/api/instance', {
      headers: { authorization: `Bearer ${token}` },
      ...(entry.mode === 'phone' ? { credentials: 'same-origin' } : {}),
      redirect: 'error',
    });
    if (response.ok) {
      entryId = EnvironmentSchema.parse(await response.json()).instanceId;
      writeStorage('pi-kit.entryInstance', entryId, 'controller');
    }
  } catch {
    /* The last known entry identity decides until the backend answers again. */
  }
  const remoteOwner = selection && selection.instanceId !== entryId ? selection.instanceId : undefined;
  configureWorkbench({ entryId, ownerId: selection?.instanceId ?? entryId, remote: !!remoteOwner, selection });
  window.addEventListener('hashchange', () => {
    const next = readWorkbenchFragment(location.hash),
      current = currentSelection() ?? selection;
    if (
      next &&
      (!current ||
        next.instanceId !== current.instanceId ||
        next.cwd !== current.cwd ||
        next.threadId !== current.threadId)
    )
      location.reload();
  });
  if (remoteOwner) await prepareUiStorage(remoteOwner);
  const backend = remoteOwner ? scopedBackendConnection(entry, remoteOwner) : entry;
  const url = await backend.url();
  await bootstrapApplication(App, buildAppConfig({ url, token }, backend, undefined, entry));
}

start().catch((err) => console.error(err));
