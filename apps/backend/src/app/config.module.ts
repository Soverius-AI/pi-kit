import { Global, Module } from '@nestjs/common';
import { loadConfig } from './config';
import { CONFIG } from './config.token';

/** Makes the validated environment injectable everywhere as `CONFIG`. */
@Global()
@Module({ providers: [{ provide: CONFIG, useFactory: () => loadConfig() }], exports: [CONFIG] })
export class ConfigModule {}
