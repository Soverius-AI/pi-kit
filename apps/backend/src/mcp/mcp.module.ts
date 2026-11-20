import { Module, type OnModuleInit } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { PiSessionService } from '../pi/pi-session.service';
import { ThreadsModule } from '../threads/threads.module';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { BrandLogos } from './brand-logos.service';
import { ComposioConnectService } from './composio/composio-connect.service';
import { ComposioController } from './composio/composio.controller';
import { ComposioService } from './composio/composio.service';
import { McpCallService } from './mcp-call.service';
import { McpEditService } from './mcp-edit.service';
import { McpController, McpSandboxController } from './mcp.controller';
import { McpService } from './mcp.service';

/**
 * The MCP panel and connectors: the servers of a session, their tools and sandboxed apps, the config editor, and
 * connector sign-in.
 */
@Module({
  imports: [DbModule, PiModule, ThreadsModule],
  controllers: [McpController, McpSandboxController, ConnectorsController, ComposioController],
  providers: [
    BrandLogos,
    McpService,
    ConnectorsService,
    McpEditService,
    ComposioService,
    ComposioConnectService,
    McpCallService,
  ],
  exports: [McpService, McpCallService, ComposioConnectService],
})
export class McpModule implements OnModuleInit {
  constructor(
    private readonly sessions: PiSessionService,
    private readonly composio: ComposioService,
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.sessions.setReadOnlyServers(
      async () => new Set([...(await this.composio.readOnlyServers()), ...(await this.connectors.readOnlyServers())]),
    );
  }
}
