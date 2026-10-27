import { Module } from '@nestjs/common';
import { CONFIG } from '../app/config.token';
import type { BackendConfig } from '../app/config';
import { SkillCatalog } from './skills-search';
import { PiModule } from '../pi/pi.module';
import { SkillsController } from './skills.controller';

@Module({
  imports: [PiModule],
  controllers: [SkillsController],
  providers: [
    { provide: SkillCatalog, inject: [CONFIG], useFactory: (config: BackendConfig) => new SkillCatalog(config.skills) },
  ],
})
export class SkillsModule {}
