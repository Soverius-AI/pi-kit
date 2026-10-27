import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { BrowserController } from './browser.controller';
import { BrowserService } from './browser.service';

/** The browser artifact: the page the desktop app keeps per thread, read and driven through `BrowserService`. */
@Module({ imports: [DbModule, PiModule], controllers: [BrowserController], providers: [BrowserService] })
export class BrowserModule {}
