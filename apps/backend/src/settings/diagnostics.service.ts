import { readdirSync, statSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { Diagnostics } from '@pi-kit/protocol';
import { BOOT_ID, STARTED_AT } from '../app/boot';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { DatabaseService } from '../db/database.service';
import { agentDirOf } from '../pi/pi-resolution';
import { PiUpdateService } from '../pi/pi-update.service';

/** The switches that change what the backend does. Names and values only; no token, key or path of a secret is among them. */
const FLAGS = ['NODE_ENV', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_KIT_ALLOW_RESTART', 'PI_KIT_TRUSTED_CWDS', 'PI_CODING_AGENT_DIR', 'PI_KIT_PI_DIR', 'PI_KIT_DESKTOP'] as const;

/**
 * Settings › Advanced › Diagnostics: what a bug report needs to know about this backend, in one object the dialog shows and
 * "Copy diagnostics" puts on the clipboard. It reads; nothing here changes state, and nothing secret (the token, a key) is part of it.
 */
@Injectable()
export class DiagnosticsService {
  constructor(
    @Inject(CONFIG) private readonly config: BackendConfig,
    private readonly database: DatabaseService,
    private readonly updates: PiUpdateService,
  ) {}

  async read(): Promise<Diagnostics> {
    const about = await this.updates.about();
    const logDir = process.env['PI_KIT_LOG_DIR'] || join(this.config.dataDir, 'logs');
    return {
      backend: {
        host: this.config.host,
        port: this.config.port,
        bootId: BOOT_ID,
        startedAt: STARTED_AT,
        pid: process.pid,
        desktop: about.app.desktop,
        dev: this.config.dev,
      },
      app: { version: about.app.version, node: about.node, platform: platform(), arch: arch() },
      pi: { version: about.pi.version, source: about.pi.source, packageDir: about.pi.packageDir, agentDir: agentDirOf(process.env) },
      paths: { dataDir: this.config.dataDir, database: this.database.path, logDir, defaultCwd: this.config.defaultCwd },
      logs: logFiles(logDir),
      flags: FLAGS.filter((name) => process.env[name] !== undefined && process.env[name] !== '').map((name) => ({ name, value: process.env[name] as string })),
    };
  }
}

/** The files in the log folder (not subfolders), newest first, at most 20. */
export function logFiles(dir: string): Diagnostics['logs'] {
  try {
    return readdirSync(dir)
      .flatMap((name) => {
        try {
          const path = join(dir, name);
          const stat = statSync(path);
          return stat.isFile() ? [{ name, path, size: stat.size, modified: stat.mtimeMs }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 20);
  } catch {
    return [];
  }
}
