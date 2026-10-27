import { Module } from '@nestjs/common';
import { PiModule } from '../pi/pi.module';
import { UpdateModule } from '../update/update.module';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';

/** Pi packages in Settings › Extensions and skills. */
@Module({ imports: [PiModule, UpdateModule], controllers: [PackagesController], providers: [PackagesService] })
export class PackagesModule {}
