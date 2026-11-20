import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { ComposioController } from './composio.controller';
import { ComposioService } from './composio.service';
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
  providers: [McpService, ConnectorsService, McpEditService, ComposioService, McpCallService],
  exports: [McpService, McpCallService],
})
export class McpModule {}
