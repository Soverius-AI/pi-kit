import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type LocalSaveResult,
  LocalSaveResultSchema,
  LocalSaveSchema,
  type LocalTestResult,
  LocalTestResultSchema,
  LocalTestSchema,
  type OnboardingState,
  OnboardingStateRequestSchema,
  OnboardingStateSchema,
  ReadyCheckSchema,
  type ReadyResult,
  ReadyResultSchema,
  type ScratchFolder,
  ScratchFolderSchema,
  type SetupInfo,
  SetupInfoSchema,
} from '@pi-kit/protocol';
import type { z } from 'zod';
import { Fails, Responds } from '../contract';
import { SetupService } from './setup.service';

/** The onboarding's own calls; sign-in is `POST /api/auth/login`, settings are `PATCH /api/pi-settings`, folders are `POST /api/workspaces`. */
@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get()
  @ApiOperation({ summary: 'Detect the setup', description: 'Looks at the machine and answers what the onboarding needs: the pi that runs, the stored credentials, the providers with a usable model and the local model servers it found.' })
  @Responds(SetupInfoSchema)
  detect(): Promise<SetupInfo> {
    return this.setup.detect();
  }

  /** The user finished the flow, or left it: it does not open by itself again (a missing model after a skip is the composer's to explain). */
  @Post('state')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record how the onboarding ended', description: 'Records that the person finished the onboarding or left it, so it does not open by itself again.' })
  @Responds(OnboardingStateSchema)
  state(@Body({ schema: OnboardingStateRequestSchema }) body: z.infer<typeof OnboardingStateRequestSchema>): OnboardingState {
    return this.setup.setState(body.state);
  }

  @Post('local/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Test a local model server', description: 'Asks a server at a base URL which models it lists. A server that does not answer is a result with `ok: false`, not an error.' })
  @Responds(LocalTestResultSchema)
  testLocal(@Body({ schema: LocalTestSchema }) body: z.infer<typeof LocalTestSchema>): Promise<LocalTestResult> {
    return this.setup.testLocal(body.baseUrl);
  }

  @Post('local/save')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save a local model server', description: "Writes the server and its models into pi's models file, and answers with the provider id and the file." })
  @Responds(LocalSaveResultSchema)
  @Fails({ 400: 'The models file could not be written.' })
  async saveLocal(@Body({ schema: LocalSaveSchema }) body: z.infer<typeof LocalSaveSchema>): Promise<LocalSaveResult> {
    try {
      return await this.setup.saveLocal(body);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Post('scratch')
  @HttpCode(200)
  @ApiOperation({ summary: 'Make a scratch folder', description: 'Makes an empty folder to start the first thread in, and answers with its path.' })
  @Responds(ScratchFolderSchema)
  scratch(): ScratchFolder {
    return this.setup.scratchFolder();
  }

  /** "pi is ready": one cheap request with the model the user picked. */
  @Post('ready')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check that pi is ready', description: 'Makes one cheap request with the model the person picked, and answers whether it worked and how long it took.' })
  @Responds(ReadyResultSchema)
  ready(@Body({ schema: ReadyCheckSchema }) body: z.infer<typeof ReadyCheckSchema>): Promise<ReadyResult> {
    return this.setup.ready(body.provider, body.modelId);
  }
}
