import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { ComputerUsePackage } from './computer-use-package';
import { ComputerUseController } from './computer-use.controller';
import { ComputerUseService } from './computer-use.service';

/** Opt-in computer use: installs the bundled `@pi-kit/computer-use` pi package into pi's settings once, and serves Settings › Computer use. */
@Module({ imports: [DbModule, PiModule], controllers: [ComputerUseController], providers: [ComputerUsePackage, ComputerUseService] })
export class ComputerUseModule {}
