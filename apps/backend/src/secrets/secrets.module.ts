import { Global, Module } from '@nestjs/common';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { startupSecretStore } from './security-config';
import { DbModule } from '../db/db.module';
import { SecretsService } from './secrets.service';
import { SECRET_STORE } from './tokens';

/**
 * Select storage before opening the database. Fresh macOS profiles do not access Keychain;
 * existing encrypted profiles retain access to their original key. Migration is never automatic.
 */
@Global()
@Module({ providers: [{ provide: SECRET_STORE, inject: [CONFIG], useFactory: (config: BackendConfig) => startupSecretStore(config.dataDir) }], exports: [SECRET_STORE] })
export class SecretStoreModule {}

/** The policy around the store: resolvers, the launcher, what Settings shows. */
@Global()
@Module({ imports: [DbModule], providers: [SecretsService], exports: [SecretsService] })
export class SecretsModule {}
