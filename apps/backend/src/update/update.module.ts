import { Module } from '@nestjs/common';
import { PiModule } from '../pi/pi.module';
import { UpdateController } from './update.controller';
import { UpdateService } from './update.service';

/** Updates from inside the app: `UpdateService` with its one background job and the periodic check, and the `/api/update` routes. */
@Module({ imports: [PiModule], controllers: [UpdateController], providers: [UpdateService], exports: [UpdateService] })
export class UpdateModule {}
