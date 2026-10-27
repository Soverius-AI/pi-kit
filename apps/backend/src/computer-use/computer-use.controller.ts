import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { type ComputerUseState, ComputerUsePermissionSchema, ComputerUseStateSchema, type SetComputerUse, SetComputerUseSchema } from '@pi-kit/protocol';
import { Fails, Responds } from '../contract';
import { ComputerUseService } from './computer-use.service';

/** Settings › Computer use (`@pi-kit/computer-use`): the switch, the app macOS asks, and the macOS permissions. */
@ApiTags('computer-use')
@Controller('computer-use')
export class ComputerUseController {
  constructor(private readonly computerUse: ComputerUseService) {}

  @Get()
  @ApiOperation({
    summary: 'Get computer use',
    description:
      'Whether the package is installed and computer use is on, which app macOS gives the permissions to (pi-kit, Electron for a development build, or the terminal that started the backend), ' +
      'and on macOS, while it is on, whether Accessibility and Screen Recording are granted and whether a relaunch is needed for a new Screen Recording grant.',
  })
  @Responds(ComputerUseStateSchema)
  state(): Promise<ComputerUseState> {
    return this.computerUse.state();
  }

  @Put()
  @ApiOperation({ summary: 'Turn computer use on or off', description: 'Writes the same saved choice as `/computer-use on | off` and reloads the idle sessions, so their computer tools appear or go.' })
  @Responds(ComputerUseStateSchema)
  @Fails({ 404: 'The computer-use package is not installed, or this system is not macOS, Windows or Linux.' })
  set(@Body({ schema: SetComputerUseSchema }) body: SetComputerUse): Promise<ComputerUseState> {
    return this.computerUse.setEnabled(body.enabled);
  }

  @Post('permissions/:permission/open')
  @HttpCode(200)
  @ApiParam({ name: 'permission', description: '`accessibility` or `screenRecording`.', schema: { type: 'string', enum: ComputerUsePermissionSchema.options } })
  @ApiOperation({
    summary: 'Ask macOS for a computer-use permission',
    description: 'Shows macOS’s own prompt (which also adds the app to the list, switched off) and opens the permission’s page in System Settings. Outside macOS nothing happens.',
  })
  @Responds(ComputerUseStateSchema)
  @Fails({ 400: 'Not a computer-use permission.', 404: 'The computer-use package is not installed.' })
  open(@Param('permission') permission: string): Promise<ComputerUseState> {
    const parsed = ComputerUsePermissionSchema.safeParse(permission);
    if (!parsed.success) throw new BadRequestException('Not a computer-use permission.');
    return this.computerUse.open(parsed.data);
  }
}
