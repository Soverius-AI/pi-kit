// Both real processes finish loading, then wait here before calling the public lock API.
// The parent releases them together; the winner retains ownership until the parent kills it.
import fs from 'node:fs';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const [dir] = process.argv.slice(2);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { takeOwnerLock, StoreOwnedError } = await jiti.import('../durable-storage.ts');
fs.writeFileSync(join(dir, `ready-${process.pid}`), '');
const deadline = Date.now() + 10_000;
while (!fs.existsSync(join(dir, 'acquire'))) {
  if (Date.now() > deadline) throw new Error('The parent did not release the acquisition barrier.');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
let lock;
try {
  lock = takeOwnerLock(dir);
  process.stdout.write(`${JSON.stringify({ owned: true, epoch: lock.epoch })}\n`);
} catch (error) {
  if (!(error instanceof StoreOwnedError)) throw error;
  process.stdout.write(`${JSON.stringify({ owned: false })}\n`);
}
// Keep the owner handle reachable, as BgAgentsService does, until shutdown; otherwise GC may close its SQLite connection.
process.once('SIGTERM', () => { lock?.release(); process.exit(0); });
setInterval(() => undefined, 1000);
