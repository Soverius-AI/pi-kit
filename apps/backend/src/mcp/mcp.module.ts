import { Module } from '@nestjs/common';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { McpEditService } from './mcp-edit.service';
import { McpController, McpSandboxController } from './mcp.controller';
import { McpService } from './mcp.service';

/**
 * The MCP panel and connectors: the servers of a session, their tools and sandboxed apps, the config editor, and
 * connector sign-in.
 */
@Module({
  imports: [PiModule, ThreadsModule],
  controllers: [McpController, McpSandboxController, ConnectorsController],
  providers: [McpService, ConnectorsService, McpEditService],
  exports: [McpService],
})
export class McpModule {}
