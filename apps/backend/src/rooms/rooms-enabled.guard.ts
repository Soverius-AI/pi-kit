import { type CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ROOMS_SETTING_KEY } from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';

export const ROOMS_OFF = 'Rooms are off on this environment.';

@Injectable()
export class RoomsEnabledGuard implements CanActivate {
  constructor(private readonly meta: MetaRepository) {}

  async canActivate(): Promise<boolean> {
    if ((await this.meta.getSetting(ROOMS_SETTING_KEY)) === true) return true;
    throw new NotFoundException(ROOMS_OFF);
  }
}
