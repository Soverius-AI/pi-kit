import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { DesktopModule } from '../desktop/desktop.module';
import { PeerHttp } from './peer-http';
import { PeerProofs } from './peer-proofs';
import { PeerProxy } from './peer-proxy';
import { PeerSessions } from './peer-sessions';
import { ProjectFoldersController } from './project-folders.controller';
import { PeersController } from './peers.controller';
import { PeersService } from './peers.service';
import {
  IncomingPeerProxyController,
  OutgoingPeerProxyController,
  PeerTransportController,
} from './peer-transport.controller';

@Module({
  imports: [DbModule, DesktopModule],
  providers: [PeerHttp, PeerProofs, PeerSessions, PeersService, PeerProxy],
  controllers: [
    PeersController,
    ProjectFoldersController,
    PeerTransportController,
    OutgoingPeerProxyController,
    IncomingPeerProxyController,
  ],
  exports: [PeersService, PeerSessions, PeerProxy],
})
export class PeersModule {}
