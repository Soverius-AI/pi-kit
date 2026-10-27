import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { McpModule } from '../mcp/mcp.module';
import { PiModule } from '../pi/pi.module';
import { ThreadsModule } from '../threads/threads.module';
import { AguiController } from './agui.controller';
import { AguiService } from './agui.service';
import { PiAgentRunner } from './pi-agent-runner';
import { GenUiSandboxController } from './genui-sandbox.controller';

/**
 * The AG-UI module: CopilotKit's runtime route (`AguiController`, `AguiService`), the `PiAgentRunner` that runs pi
 * behind it, and the generated UI sandbox frame. The service and the runner are exported so a run can also start
 * without a browser.
 */
@Module({
  imports: [PiModule, DbModule, ThreadsModule, McpModule],
  controllers: [AguiController, GenUiSandboxController],
  providers: [AguiService, PiAgentRunner],
  // `AguiService.runHeadless` starts a run without a browser (a skill verification thread); the runner takes the `pi-bg` agent's runner.
  exports: [AguiService, PiAgentRunner],
})
export class AguiModule {}
