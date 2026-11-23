import { Inject, Injectable } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';

@Injectable()
export class RoomFolders {
  static readonly PLAYBOOKS = 'playbooks';

  constructor(@Inject(CONFIG) private readonly config: BackendConfig) {}

  ensure(roomId: string): string {
    const folder = join(this.config.dataDir, 'rooms', roomId);
    mkdirSync(join(folder, RoomFolders.PLAYBOOKS), { recursive: true });
    for (const name of ['folders', 'inbox', 'outputs'])
      mkdirSync(join(folder, 'workspace', name), { recursive: true, mode: 0o700 });
    return folder;
  }

  workspace(roomId: string): string {
    return join(this.ensure(roomId), 'workspace');
  }
}
