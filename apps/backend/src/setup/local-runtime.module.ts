import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { LocalHardwareService } from './local-hardware.service';
import { LocalLlamaSwapService } from './local-llama-swap.service';
import { LocalLlamaSwapProcessService } from './local-llama-swap-process.service';
import { LocalModelCatalogService } from './local-model-catalog.service';
import { LocalModelFilesService } from './local-model-files.service';
import { LocalRuntimeController } from './local-runtime.controller';
import { LocalRuntimeService } from './local-runtime.service';

/**
 * Local models: hardware detection, the catalog, the model files, the llama-swap config and process, and the one
 * setup job at a time.
 */
@Module({ imports: [DbModule], controllers: [LocalRuntimeController], providers: [LocalHardwareService, LocalModelCatalogService, LocalModelFilesService, LocalLlamaSwapService, LocalLlamaSwapProcessService, LocalRuntimeService] })
export class LocalRuntimeModule {}
