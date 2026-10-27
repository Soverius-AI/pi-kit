import { isProviderAccount } from '@pi-kit/protocol';
import type { SecretStore } from './store';

/**
 * `pi-kit-secret`: get, set, delete and list the entries pi-kit keeps in the operating system's credential store (service `pi-kit`, one account per
 * provider). It exists so that the pi command line can resolve a key that pi-kit stored without pi-kit running (`"key": "!pi-kit-secret get openrouter"` in `auth.json`),
 * on Windows and on a Linux without `secret-tool`. The value of `set` is read from standard input or from a prompt that does not echo, never from an argument (arguments
 * show up in `ps` and in shell history). `get` prints the value and nothing else on standard output; every message goes to standard error; no message contains a value.
 */
export interface CliIo {
  /** Everything piped in, or undefined when standard input is a terminal. */
  readStdin(): Promise<string | undefined>;
  /** A prompt that does not echo what is typed (a terminal). */
  promptHidden(message: string): Promise<string>;
  out(text: string): void;
  err(text: string): void;
}

export const USAGE = `Usage: pi-kit-secret <command> [account]

  get <account>      print the secret stored for the account (exit 1 when there is none)
  get <account> --bearer   print it as an HTTP header value, "Bearer <secret>" (connectors)
  set <account>      store a secret; it is read from standard input, or typed without echo
  delete <account>   remove the entry
  list               print the accounts that have an entry (never the secrets)

An account is a provider id such as openrouter or anthropic. The entries live in the
operating system's credential store under the service "pi-kit".
`;

/** The reserved accounts pi-kit keeps for itself (`pi-kit/db`) cannot be read or changed through the command, only listed. */
const allowed = (account: string): boolean => isProviderAccount(account);

export async function runCli(args: readonly string[], io: CliIo, store: SecretStore): Promise<number> {
  const [command, account, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.err(USAGE);
    return command ? 0 : 2;
  }
  if (!['get', 'set', 'delete', 'list'].includes(command)) {
    io.err(`pi-kit-secret: unknown command "${command}".\n${USAGE}`);
    return 2;
  }
  const bearer = command === 'get' && rest.length === 1 && rest[0] === '--bearer';
  if (rest.length > 0 && !bearer) {
    io.err('pi-kit-secret: too many arguments. A secret is never an argument; `set` reads it from standard input.\n');
    return 2;
  }
  if (!store.available()) {
    io.err('pi-kit-secret: there is no credential store on this machine (a headless Linux needs a Secret Service such as gnome-keyring).\n');
    return 3;
  }
  try {
    if (command === 'list') {
      for (const name of await store.list()) io.out(`${name}\n`);
      return 0;
    }
    if (!account) {
      io.err(`pi-kit-secret: ${command} needs an account, for example: pi-kit-secret ${command} openrouter\n`);
      return 2;
    }
    if (!allowed(account)) {
      io.err(`pi-kit-secret: "${account}" is not a provider id (letters, digits, dot, dash and underscore).\n`);
      return 2;
    }
    if (command === 'get') {
      const value = await store.get(account);
      if (value === undefined) {
        io.err(`pi-kit-secret: there is no secret stored for ${account}.\n`);
        return 1;
      }
      io.out(`${bearer ? 'Bearer ' : ''}${value}\n`);
      return 0;
    }
    if (command === 'delete') {
      const removed = await store.delete(account);
      io.err(removed ? `Removed the entry for ${account}.\n` : `There was no entry for ${account}.\n`);
      return removed ? 0 : 1;
    }
    // set
    const piped = await io.readStdin();
    const value = (piped ?? (await io.promptHidden(`Secret for ${account}: `))).replace(/\r?\n$/, '');
    if (value === '') {
      io.err('pi-kit-secret: nothing to store; the secret was empty.\n');
      return 2;
    }
    await store.set(account, value);
    io.err(`Stored the secret for ${account} (${store.label}).\n`);
    return 0;
  } catch (error) {
    io.err(`pi-kit-secret: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
