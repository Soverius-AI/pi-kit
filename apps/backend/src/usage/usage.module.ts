import { Module } from '@nestjs/common';
import { PiModule } from '../pi/pi.module';
import { PiConfigService } from '../pi/pi-config.service';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

/** Provider usage in Settings: `UsageService` built on `PiConfigService` for the credentials, and `GET /api/providers/:id/usage`. */
@Module({
  imports: [PiModule],
  controllers: [UsageController],
  providers: [{ provide: UsageService, useFactory: (config: PiConfigService) => new UsageService(config), inject: [PiConfigService] }],
})
export class UsageModule {}
