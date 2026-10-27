import { join } from 'node:path';

export const DEFAULT_SHUTDOWN_POLICY = { parentPollMs: 1000, graceMs: 15_000 } as const;

export interface BackendConfig {
  token: string;
  port: number;
  host: string;
  /** Origins allowed by CORS (the renderer). */
  origins: string[];
  dev: boolean;
  /** Folder pi works in for a thread that does not name one (`PI_KIT_CWD`, default: the process's cwd). */
  defaultCwd: string;
  /** Folder for the SQLite database (`PI_KIT_DATA_DIR`, Electron passes its userData path). */
  dataDir: string;
  shutdown?: { parentPid?: number; parentPollMs: number; graceMs: number };
  localRuntime?: { modelDirectories?: string[]; probeMs?: number; installMs?: number; downloadMs?: number; inferenceMs?: number };
}

/** Reads and validates the environment; the backend refuses to start without a token or a port. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const token = env['PI_KIT_TOKEN'];
  if (!token || token.length < 16) {
    throw new Error('PI_KIT_TOKEN is required (at least 16 characters).');
  }
  const port = Number(env['PI_KIT_PORT']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PI_KIT_PORT is required and must be a valid port.');
  }
  const origins = (env['PI_KIT_ORIGIN'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const defaultCwd = env['PI_KIT_CWD'] || process.cwd();
  const dataDir = env['PI_KIT_DATA_DIR'] || join(process.cwd(), '.pi-kit-data');
  const parentPid = Number(env['PI_KIT_PARENT_PID']);
  const shutdown = { ...DEFAULT_SHUTDOWN_POLICY, ...(Number.isInteger(parentPid) && parentPid > 0 ? { parentPid } : {}) };
  return { token, port, host: '127.0.0.1', origins, dev: env['NODE_ENV'] === 'development', defaultCwd, dataDir, shutdown };
}
