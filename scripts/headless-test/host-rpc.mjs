// Local administrative test client. Never attaches as a desktop or obtains the backend token.
// Run as the profile owner INSIDE the container. Do not expose this socket over TCP.
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const allowed = new Set([
  'status',
  'remote.status',
  'remote.start',
  'remote.stop',
  'remote.setupUrl',
  'remote.beginPairing',
  'remote.approvePairing',
  'remote.rejectPairing',
  'remote.revokeDevice',
]);
const [method = 'status', rawParams] = process.argv.slice(2);
if (!allowed.has(method)) throw new Error(`Unsupported test method: ${method}`);
const params = rawParams === undefined ? undefined : JSON.parse(rawParams);
const dataDir = process.env.PI_KIT_DATA_DIR || join(homedir(), '.config', 'pi-kit');
const discovery = JSON.parse(await readFile(join(dataDir, 'service.json'), 'utf8'));
const socket = createConnection(discovery.socket);
socket.setEncoding('utf8');
const timer = setTimeout(() => socket.destroy(new Error('Host RPC timed out after 30 seconds')), 30_000);
let buffer = '';
let answered = false;
socket.on('connect', () => {
  socket.write(JSON.stringify({ t: 'hello', token: discovery.token }) + '\n');
  socket.write(JSON.stringify({ t: 'call', id: 1, method, ...(params === undefined ? {} : { params }) }) + '\n');
});
socket.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) return socket.destroy(new Error('Unexpectedly large host response'));
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const frame = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (frame.id !== 1 || !['result', 'error'].includes(frame.t)) continue;
    answered = true;
    clearTimeout(timer);
    if (frame.t === 'error') {
      console.error(frame.message);
      process.exitCode = 1;
    } else {
      // Results may contain a short-lived pairing code. Keep logs private.
      console.log(JSON.stringify(frame.result ?? null, null, 2));
    }
    socket.end();
  }
});
socket.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
socket.on('close', () => {
  clearTimeout(timer);
  if (!answered) {
    console.error('Host closed the connection without a response');
    process.exitCode = 1;
  }
});
