// What a host app uses of this package without pi in it: pi-kit's backend reads and writes the saved choice, names the app macOS asks, and reads or
// requests the macOS permissions for its Settings › Computer use page. The SDK (and with it the native library) is loaded only when a permission is asked about.
export { configPath, host, isEnabled, missingPermissions, PERMISSIONS, setEnabled } from './computer-use.mjs';

let sdk;
const load = async () => (sdk ??= await import('@trycua/cua-driver'));

/** `{ accessibility, screenRecording }` as macOS answers this process; outside macOS both are true (nothing to grant). */
export async function permissions() {
  if (process.platform !== 'darwin') return { accessibility: true, screenRecording: true };
  return (await load()).currentMacOsPermissionStatus();
}

/** Asks macOS for both permissions: its prompts, and the app added to both lists (switched off) so the person only has to switch it on. */
export async function requestPermissions() {
  if (process.platform !== 'darwin') return { accessibility: true, screenRecording: true };
  return (await load()).requestMacOsPermissions();
}
