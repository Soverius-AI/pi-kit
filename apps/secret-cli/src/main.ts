import { runCli, selectSecretStore, type CliIo } from '@pi-kit/secret-store';
import { cliStoreEnvironment } from './store-env';

/** `pi-kit-secret`: the process wrapper around `runCli`, which holds the commands and has the unit tests. */

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => (text += chunk));
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

/** A line typed on the terminal with echo off (raw mode), ended by Enter; Ctrl-C leaves without storing anything. */
function promptHidden(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(message);
    let text = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          return reject(new Error('Cancelled.'));
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stderr.write('\n');
          return resolve(text);
        }
        if (char === '\u007f' || char === '\b') text = text.slice(0, -1);
        else text += char;
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

const io: CliIo = {
  readStdin: async () => (process.stdin.isTTY ? undefined : readAll(process.stdin)),
  promptHidden,
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

// Resolve the explicit store inside the promise so invalid settings use the safe CLI error path too.
Promise.resolve().then(() => runCli(process.argv.slice(2), io, selectSecretStore(cliStoreEnvironment(process.env)))).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`pi-kit-secret: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
