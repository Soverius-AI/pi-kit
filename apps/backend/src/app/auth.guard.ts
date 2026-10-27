import { timingSafeEqual } from 'node:crypto';
import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiExtension } from '@nestjs/swagger';
import { CONFIG } from './config.token';
import type { BackendConfig } from './config';

export const IS_PUBLIC = 'pi-kit:public';
/** Marks a route as exempt from the bearer token. Use sparingly. */
export const Public = () => applyDecorators(SetMetadata(IS_PUBLIC, true), ApiExtension('x-public', true));

/** Rejects every request that does not carry `Authorization: Bearer <PI_KIT_TOKEN>`. */
@Injectable()
export class BearerTokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) config: BackendConfig,
  ) {
    this.expected = Buffer.from(config.token);
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const header: string | undefined = context.switchToHttp().getRequest().headers['authorization'];
    const match = /^Bearer (.+)$/.exec(header ?? '');
    if (!match) throw new UnauthorizedException();
    const given = Buffer.from(match[1]);
    if (given.length !== this.expected.length || !timingSafeEqual(given, this.expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
